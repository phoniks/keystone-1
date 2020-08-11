const crypto = require('crypto');
const fs = require('fs');
const execa = require('execa');
const { execSync } = require('child_process');
const { resolveBinary, getGenerators } = require('@prisma/sdk');
const { BaseKeystoneAdapter, BaseListAdapter, BaseFieldAdapter } = require('@keystonejs/keystone');
const { escapeRegExp, defaultObj, mapKeys, identity, flatten } = require('@keystonejs/utils');

class PrismaAdapter extends BaseKeystoneAdapter {
  constructor() {
    super(...arguments);
    this.name = 'prisma';
    this.listAdapterClass = this.listAdapterClass || this.defaultListAdapterClass;
  }

  async _connect({ rels }) {
    const path = await this._generateClient(rels);
    const { PrismaClient } = require(`../../../${path}/generated-client`);

    this.prisma = new PrismaClient({
      // log: ['query'],
      datasources: { postgresql: { url: `${process.env.DATABASE_URL}?schema=${this.schemaName}` } },
    });
  }

  async _generateClient(rels) {
    // https://github.com/prisma/prisma/issues/3265
    const prismaSchema = (
      await execa(await resolveBinary('prisma-fmt'), ['format'], {
        env: { ...process.env, RUST_BACKTRACE: '1' },
        maxBuffer: 1000 * 1000 * 1000,
        input: this.generatePrismaSchema(rels),
      })
    ).stdout;

    // Compute the hash
    this.hash = crypto
      .createHash('sha256')
      .update(prismaSchema)
      .digest('hex');

    // Slice down to make a valid postgres schema name
    this.schemaName = this.hash.slice(0, 16);

    // See if there is a prisma client available for this hash
    const base = '.api-test-prisma-clients';
    const path = `${base}/${this.hash}`;
    if (!fs.existsSync(path)) {
      // mkdir
      fs.mkdirSync(path, { recursive: true });

      // write prisma file
      fs.writeSync(fs.openSync(`${path}/schema.prisma`, 'w'), prismaSchema);

      // generate prisma client
      const generator = (await getGenerators({ schemaPath: `${path}/schema.prisma` }))[0];
      await generator.generate();
      generator.stop();
    }
    return path;
  }

  generatePrismaSchema(rels) {
    const models = Object.values(this.listAdapters).map(listAdapter => {
      const scalarFields = flatten(
        listAdapter.fieldAdapters
          .filter(f => !f.field.isRelationship)
          .filter(f => f.path !== 'id')
          .map(f => f.getPrismaSchema())
      );

      const relFields = [
        ...flatten(
          listAdapter.fieldAdapters
            .map(({ field }) => field)
            .filter(f => f.isRelationship)
            .map(f => {
              const r = rels.find(r => r.left === f || r.right === f);
              const isLeft = r.left === f;
              if (r.cardinality === 'N:N') {
                const relName = r.tableName;
                return [`${f.path} ${f.refListKey}[] @relation("${relName}", references: [id])`];
              } else {
                const relName = `${r.tableName}${r.columnName}`;
                if (
                  (r.cardinality === 'N:1' && isLeft) ||
                  (r.cardinality === '1:N' && !isLeft) ||
                  (r.cardinality === '1:1' && isLeft)
                ) {
                  // We're the owner of the foreign key column
                  return [
                    `${f.path} ${f.refListKey}? @relation("${relName}", fields: [${f.path}Id], references: [id])`,
                    `${f.path}Id Int? @map("${r.columnName}")`,
                  ];
                } else if (r.cardinality === '1:1') {
                  return [`${f.path} ${f.refListKey}? @relation("${relName}")`];
                } else {
                  return [`${f.path} ${f.refListKey}[] @relation("${relName}")`];
                }
              }
            })
        ),
        ...flatten(
          rels
            .filter(({ right }) => !right)
            .filter(({ left }) => left.refListKey === listAdapter.key)
            .filter(({ cardinality }) => cardinality === 'N:N')
            .map(({ left: { path, listKey }, tableName }) => [
              `from_${path} ${listKey}[] @relation("${tableName}", references: [id])`,
            ])
        ),
      ];

      return `
        model ${listAdapter.key} {
          id Int @id @default(autoincrement())
          ${[...scalarFields, ...relFields].join('\n  ')}
        }`;
    });

    const enums = flatten(
      Object.values(this.listAdapters).map(listAdapter =>
        flatten(
          listAdapter.fieldAdapters
            .filter(f => !f.field.isRelationship)
            .filter(f => f.path !== 'id')
            .map(f => f.getPrismaEnums())
        )
      )
    );

    const header = `
      datasource postgresql {
        url      = env("DATABASE_URL")
        provider = "postgresql"
      }
      generator client {
        provider = "prisma-client-js"
        output = "generated-client"
      }`;
    return header + models.join('\n') + '\n' + enums.join('\n');
  }

  async postConnect({ rels }) {
    Object.values(this.listAdapters).forEach(listAdapter => {
      listAdapter._postConnect({ rels, prisma: this.prisma });
    });

    if (this.config.dropDatabase && process.env.NODE_ENV !== 'production') {
      await this.dropDatabase();
    }
    return [];
  }

  // This will drop all the tables in the backing database. Use wisely.
  async dropDatabase() {
    let migrationNeeded = true;
    for (const { tablename } of await this.prisma.$queryRaw(
      `SELECT tablename FROM pg_tables WHERE schemaname='${this.schemaName}'`
    )) {
      if (tablename.includes('_Migration')) {
        migrationNeeded = false;
      }
      await this.prisma.$queryRaw(
        `TRUNCATE TABLE \"${this.schemaName}\".\"${tablename}\" CASCADe;`
      );
    }
    if (migrationNeeded) {
      this._runPrismaCmd('migrate save --name init --experimental');
      this._runPrismaCmd('migrate up --experimental');
    }
  }

  _runPrismaCmd(cmd) {
    return execSync(`yarn prisma ${cmd} --schema ${this.prisma._engineConfig.datamodelPath}`, {
      env: {
        ...process.env,
        DATABASE_URL: `${process.env.DATABASE_URL}?schema=${this.schemaName}`,
      },
      encoding: 'utf-8',
    });
  }

  disconnect() {
    this.prisma.$disconnect();
    delete this.prisma;
    Object.values(this.listAdapters).forEach(listAdapter => {
      delete listAdapter.prisma;
    });
    const base = '.api-test-prisma-clients';
    const path = `${base}/${this.hash}`;
    delete require.cache[require.resolve(`../../../${path}/generated-client`)];
  }

  getDefaultPrimaryKeyConfig() {
    // Required here due to circular refs
    const { AutoIncrement } = require('@keystonejs/fields-auto-increment');
    return AutoIncrement.primaryKeyDefaults[this.name].getConfig();
  }

  async checkDatabaseVersion() {
    // FIXME: Decide what/how we want to check things here
  }
}

class PrismaListAdapter extends BaseListAdapter {
  constructor(key, parentAdapter) {
    super(...arguments);
    this.getListAdapterByKey = parentAdapter.getListAdapterByKey.bind(parentAdapter);
  }

  _postConnect({ rels, prisma }) {
    // https://www.prisma.io/docs/reference/tools-and-interfaces/prisma-schema/models#queries-crud
    // "By default the name of the property is the lowercase form of the model name,
    // e.g. user for a User model or post for a Post model."
    this.model = prisma[this.key.slice(0, 1).toLowerCase() + this.key.slice(1)];
    this.fieldAdapters.forEach(fieldAdapter => {
      fieldAdapter.rel = rels.find(
        ({ left, right }) =>
          left.adapter === fieldAdapter || (right && right.adapter === fieldAdapter)
      );
    });
  }

  ////////// Mutations //////////
  _include() {
    // We don't have a "real key" (i.e. a column in the table) if:
    //  * We're a N:N
    //  * We're the right hand side of a 1:1
    //  * We're the 1 side of a 1:N or N:1 (e.g we are the one with config: many)
    const include = defaultObj(
      this.fieldAdapters
        .filter(
          a =>
            a.isRelationship &&
            (a.config.many || (a.rel.cardinality === '1:1' && a.rel.right.adapter === a))
        )
        .map(a => a.path),
      { select: { id: true } }
    );
    return Object.keys(include).length > 0 ? include : undefined;
  }

  async _create(_data) {
    return this.model.create({
      data: mapKeys(_data, (value, path) =>
        this.fieldAdaptersByPath[path] && this.fieldAdaptersByPath[path].isRelationship
          ? {
              connect: Array.isArray(value)
                ? value.map(x => ({ id: Number(x) }))
                : { id: Number(value) },
            }
          : value
      ),
      include: this._include(),
    });
  }

  async _update(id, _data) {
    const include = this._include();
    const existingItem = await this.model.findOne({ where: { id: Number(id) }, include });
    return this.model.update({
      where: { id: Number(id) },
      data: mapKeys(_data, (value, path) => {
        if (
          this.fieldAdaptersByPath[path] &&
          this.fieldAdaptersByPath[path].isRelationship &&
          Array.isArray(value)
        ) {
          const vs = value.map(x => Number(x));
          const toDisconnect = existingItem[path].filter(({ id }) => !vs.includes(id));
          const toConnect = vs
            .filter(id => !existingItem[path].map(({ id }) => id).includes(id))
            .map(id => ({ id }));
          return {
            disconnect: toDisconnect.length ? toDisconnect : undefined,
            connect: toConnect.length ? toConnect : undefined,
          };
        }
        return this.fieldAdaptersByPath[path] && this.fieldAdaptersByPath[path].isRelationship
          ? value === null
            ? { disconnect: true }
            : { connect: { id: Number(value) } }
          : value;
      }),
      include,
    });
  }

  async _delete(id) {
    return this.model.delete({ where: { id: Number(id) } });
  }

  ////////// Queries //////////
  async _itemsQuery(args, { meta = false, from = {} } = {}) {
    const filter = this.prismaFilter({ args, meta, from });
    if (meta) {
      let count = await this.model.count(filter);
      const { first, skip } = args;

      // Adjust the count as appropriate
      if (skip !== undefined) {
        count -= skip;
      }
      if (first !== undefined) {
        count = Math.min(count, first);
      }
      count = Math.max(0, count); // Don't want to go negative from a skip!
      return { count };
    } else {
      return this.model.findMany(filter);
    }
  }

  prismaFilter({ args: { where = {}, first, skip, sortBy, orderBy, search }, meta, from }) {
    const ret = {};
    const allWheres = this.processWheres(where);

    if (allWheres) {
      ret.where = allWheres;
    }

    if (from.fromId) {
      if (!ret.where) {
        ret.where = {};
      }
      const a = from.fromList.adapter.fieldAdaptersByPath[from.fromField];
      if (a.rel.cardinality === 'N:N') {
        const path = a.rel.right
          ? a.field === a.rel.right // Two-sided
            ? a.rel.left.path
            : a.rel.right.path
          : `from_${a.rel.left.path}`; // One-sided
        ret.where[path] = { some: { id: Number(from.fromId) } };
      } else {
        ret.where[a.rel.columnName] = { id: Number(from.fromId) };
      }
    }

    // TODO: Implement configurable search fields for lists
    const searchField = this.fieldAdaptersByPath['name'];
    if (search !== undefined && searchField) {
      if (searchField.fieldName === 'Text') {
        // FIXME: Think about regex
        if (!ret.where) ret.where = { name: search };
        else ret.where = { AND: [ret.where, { name: search }] };
        // const f = escapeRegExp;
        // this._query.andWhere(`${baseTableAlias}.name`, '~*', f(search));
      }
      // FIXME: How to express this in prisma?
      // else {
      //   this._query.whereRaw('false'); // Return no results
      // }
    }

    // Add query modifiers as required
    if (!meta) {
      if (first !== undefined) {
        // SELECT ... LIMIT <first>
        ret.take = first;
      }
      if (skip !== undefined) {
        // SELECT ... OFFSET <skip>
        ret.skip = skip;
      }
      if (orderBy !== undefined) {
        // SELECT ... ORDER BY <orderField>
        const [orderField, orderDirection] = orderBy.split('_');
        const sortKey = this.fieldAdaptersByPath[orderField].sortKey || orderField;
        ret.orderBy = { [sortKey]: orderDirection.toLowerCase() };
      }
      if (sortBy !== undefined) {
        // SELECT ... ORDER BY <orderField>[, <orderField>, ...]
        if (!ret.orderBy) ret.orderBy = {};
        sortBy.forEach(s => {
          const [orderField, orderDirection] = s.split('_');
          const sortKey = this.fieldAdaptersByPath[orderField].sortKey || orderField;
          ret.orderBy[sortKey] = orderDirection.toLowerCase();
        });
      }

      this.fieldAdapters
        .filter(a => a.isRelationship && a.rel.cardinality === '1:1' && a.rel.right === a.field)
        .forEach(({ path }) => {
          if (!ret.include) ret.include = {};
          ret.include[path] = true;
        });
    }
    return ret;
  }

  processWheres(where) {
    const processRelClause = (fieldPath, clause) =>
      this.getListAdapterByKey(this.fieldAdaptersByPath[fieldPath].refListKey).processWheres(
        clause
      );
    const wheres = Object.entries(where).map(([condition, value]) => {
      if (condition === 'AND' || condition === 'OR') {
        return { [condition]: value.map(w => this.processWheres(w)) };
      } else if (
        this.fieldAdaptersByPath[condition] &&
        this.fieldAdaptersByPath[condition].isRelationship
      ) {
        // Non-many relationship. Traverse the sub-query, using the referenced list as a root.
        return { [condition]: processRelClause(condition, value) };
      } else {
        // See if any of our fields know what to do with this condition
        const path = condition.split('_')[0];
        let fieldAdapter = this.fieldAdaptersByPath[path];
        // FIXME: ask the field adapter if it supports the condition type
        const supported =
          fieldAdapter && fieldAdapter.getQueryConditions(fieldAdapter.dbPath)[condition];
        if (supported) {
          return supported(value);
        } else {
          // Many relationship
          const [fieldPath, constraintType] = condition.split('_');
          return { [fieldPath]: { [constraintType]: processRelClause(fieldPath, value) } };
        }
      }
    });

    return wheres.length === 0 ? undefined : wheres.length === 1 ? wheres[0] : { AND: wheres };
  }
}

class PrismaFieldAdapter extends BaseFieldAdapter {
  constructor() {
    super(...arguments);
  }

  _schemaField({ type }) {
    const { isRequired, isUnique } = this.config;
    return `${this.path} ${type}${isRequired ? '' : '?'} ${isUnique ? '@unique' : ''}`;
  }

  getPrismaSchema() {
    return [this._schemaField({ type: 'String' })];
  }

  getPrismaEnums() {
    return [];
  }

  // The following methods provide helpers for constructing the return values of `getQueryConditions`.
  // Each method takes:
  //   `dbPath`: The database field/column name to be used in the comparison
  //   `f`: (non-string methods only) A value transformation function which converts from a string type
  //        provided by graphQL into a native adapter type.
  equalityConditions(dbPath, f = identity) {
    return {
      [this.path]: value => ({ [dbPath]: f(value) }),
      [`${this.path}_not`]: value =>
        value === null
          ? { NOT: { [dbPath]: f(value) } }
          : {
              OR: [{ NOT: { [dbPath]: f(value) } }, { [dbPath]: null }],
            },
    };
  }

  equalityConditionsInsensitive() {
    // https://github.com/prisma/prisma-client-js/issues/690
    // const f = escapeRegExp;s
    return {
      // [`${this.path}_i`]: value => b => b.where(dbPath, '~*', `^${f(value)}$`),
      // [`${this.path}_not_i`]: value => b =>
      //   b.where(dbPath, '!~*', `^${f(value)}$`).orWhereNull(dbPath),
    };
  }

  inConditions(dbPath, f = identity) {
    return {
      [`${this.path}_in`]: value =>
        value.includes(null)
          ? { OR: [{ [dbPath]: { in: value.filter(x => x !== null).map(f) } }, { [dbPath]: null }] }
          : { [dbPath]: { in: value.map(f) } },
      [`${this.path}_not_in`]: value =>
        value.includes(null)
          ? {
              AND: [
                { NOT: { [dbPath]: { in: value.filter(x => x !== null).map(f) } } },
                { NOT: { [dbPath]: null } },
              ],
            }
          : {
              OR: [{ NOT: { [dbPath]: { in: value.map(f) } } }, { [dbPath]: null }],
            },
    };
  }

  orderingConditions(dbPath, f = identity) {
    return {
      [`${this.path}_lt`]: value => ({ [dbPath]: { lt: f(value) } }),
      [`${this.path}_lte`]: value => ({ [dbPath]: { lte: f(value) } }),
      [`${this.path}_gt`]: value => ({ [dbPath]: { gt: f(value) } }),
      [`${this.path}_gte`]: value => ({ [dbPath]: { gte: f(value) } }),
    };
  }

  stringConditions(dbPath) {
    // FIXME: These don't support regex :-()
    const f = escapeRegExp;
    return {
      [`${this.path}_contains`]: value => ({ [dbPath]: { contains: f(value) } }),
      [`${this.path}_not_contains`]: value => ({
        OR: [{ NOT: { [dbPath]: { contains: f(value) } } }, { [dbPath]: null }],
      }),
      [`${this.path}_starts_with`]: value => ({ [dbPath]: { startsWith: f(value) } }),
      [`${this.path}_not_starts_with`]: value => ({
        OR: [{ NOT: { [dbPath]: { startsWith: f(value) } } }, { [dbPath]: null }],
      }),
      [`${this.path}_ends_with`]: value => ({ [dbPath]: { endsWith: f(value) } }),
      [`${this.path}_not_ends_with`]: value => ({
        OR: [{ NOT: { [dbPath]: { endsWith: f(value) } } }, { [dbPath]: null }],
      }),
    };
  }

  stringConditionsInsensitive() {
    // https://github.com/prisma/prisma-client-js/issues/690
    // const f = escapeRegExp;
    return {
      // [`${this.path}_contains_i`]: value => b => b.where(dbPath, '~*', f(value)),
      // [`${this.path}_not_contains_i`]: value => b =>
      //   b.where(dbPath, '!~*', f(value)).orWhereNull(dbPath),
      // [`${this.path}_starts_with_i`]: value => b => b.where(dbPath, '~*', `^${f(value)}`),
      // [`${this.path}_not_starts_with_i`]: value => b =>
      //   b.where(dbPath, '!~*', `^${f(value)}`).orWhereNull(dbPath),
      // [`${this.path}_ends_with_i`]: value => b => b.where(dbPath, '~*', `${f(value)}$`),
      // [`${this.path}_not_ends_with_i`]: value => b =>
      //   b.where(dbPath, '!~*', `${f(value)}$`).orWhereNull(dbPath),
    };
  }
}

PrismaAdapter.defaultListAdapterClass = PrismaListAdapter;

module.exports = { PrismaAdapter, PrismaListAdapter, PrismaFieldAdapter };
