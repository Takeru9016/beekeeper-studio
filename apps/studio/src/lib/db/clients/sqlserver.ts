// Copyright (c) 2015 The SQLECTRON Team
import { readFileSync } from 'fs';
import { parse as bytesParse } from 'bytes'
import { ConnectionPool } from 'mssql'
import { identify } from 'sql-query-identifier'
import knexlib from 'knex'
import _ from 'lodash'

import { DatabaseClient, IDbConnectionDatabase, IDbConnectionServer } from "../client"
import {
  buildDatabaseFilter,
  buildDeleteQueries,
  buildInsertQueries,
  buildSchemaFilter,
  buildSelectQueriesFromUpdates,
  buildUpdateQueries,
  escapeString,
  joinQueries,
  applyChangesSql,
} from './utils';
import logRaw from 'electron-log'
import { Statement } from "sql-query-identifier/lib/defines";
import { SqlServerCursor } from './sqlserver/SqlServerCursor'
import { SqlServerData } from '@shared/lib/dialects/sqlserver'
import { SqlServerChangeBuilder } from '@shared/lib/sql/change_builder/SqlServerChangeBuilder'
import { joinFilters } from '@/common/utils';
import {
  BasicDatabaseClient,
  ExecutionContext,
  QueryLogOptions
} from './BasicDatabaseClient'
import { TableIndex, TableProperties } from '../models';
const log = logRaw.scope('sql-server')

const D = SqlServerData
const mmsqlErrors = {
  CANCELED: 'ECANCEL',
};

type SQLServerVersion = {
  supportOffsetFetch: boolean
  releaseYear: number
  versionString: any
}

type SQLServerResult = {
  data: any,
  statement: Statement,
  // Number of changes made by the query
  changes: number
}

const SQLServerContext = {
  getExecutionContext(): ExecutionContext {
    return null;
  },
  logQuery(_query: string, _options: QueryLogOptions, _context: ExecutionContext): Promise<number | string> {
    return null;
  }
}

// NOTE:
// DO NOT USE CONCAT() in sql, not compatible with Sql Server <= 2008
// SQL Server < 2012 might eventually need its own class.
export class SQLServerClient extends BasicDatabaseClient<SQLServerResult> {
  server: IDbConnectionServer
  database: IDbConnectionDatabase
  defaultSchema: () => string
  version: SQLServerVersion
  dbConfig: any
  readOnlyMode: boolean
  logger: any
  connection: any

  constructor(server: IDbConnectionServer, database: IDbConnectionDatabase) {
    super( knexlib({ client: 'mssql'}), SQLServerContext )
    this.dialect = 'mssql';
    this.dbReadOnlyMode = server?.config?.readOnlyMode || false;
    this.server = server
    this.database = database
    this.defaultSchema = ():string => 'dbo'
    this.logger = () => log
  }

  async getVersion(): Promise<SQLServerVersion> {
    const result = await this.executeQuery("SELECT @@VERSION as version")
    const versionString = result[0]?.rows[0]?.version
    const yearRegex = /SQL Server (\d+)/g
    const yearResults = yearRegex.exec(versionString)
    const releaseYear = (yearResults && _.toNumber(yearResults[1])) || 2017
    return {
      supportOffsetFetch: releaseYear >= 2012,
      releaseYear,
      versionString
    }
  }

  async listTables(filter) {
    const schemaFilter = buildSchemaFilter(filter, 'table_schema');
    const sql = `
      SELECT
        table_schema,
        table_name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE table_type NOT LIKE '%VIEW%'
      ${schemaFilter ? `AND ${schemaFilter}` : ''}
      ORDER BY table_schema, table_name
    `;

    const { data } = await this.driverExecuteQuery({ query: sql })

    return data.recordset.map((item) => ({
      schema: item.table_schema,
      name: item.table_name,
    }))
  }

  async listTableColumns(_, table, schema) {
    const clauses = []
    if (table) clauses.push(`table_name = ${D.escapeString(table, true)}`)
    if (schema) clauses.push(`table_schema = ${D.escapeString(schema, true)}`)
    const clause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ''
    const sql = `
      SELECT
        table_schema as "table_schema",
        table_name as "table_name",
        column_name as "column_name",
        ordinal_position as "ordinal_position",
        column_default as "column_default",
        is_nullable as "is_nullable",
        CASE
          WHEN character_maximum_length is not null AND data_type != 'text'
              THEN data_type + '(' + CAST(character_maximum_length AS VARCHAR(16)) + ')'
          WHEN numeric_precision is not null
              THEN data_type + '(' + CAST(numeric_precision AS VARCHAR(16)) + ')'
          WHEN datetime_precision is not null AND data_type != 'date'
              THEN data_type + '(' + CAST(datetime_precision AS VARCHAR(16)) + ')'
          ELSE data_type
        END as "data_type"
      FROM INFORMATION_SCHEMA.COLUMNS
      ${clause}
      ORDER BY table_schema, table_name, ordinal_position
    `

    const { data } = await this.driverExecuteQuery({ query: sql })

    return data.recordset.map((row) => ({
      schemaName: row.table_schema,
      tableName: row.table_name,
      columnName: row.column_name,
      dataType: row.data_type,
      ordinalPosition: Number(row.ordinal_position),
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default
    }))
  }

  versionString(): string {
    return this.version.versionString.split(" \n\t")[0]
  }

  async executeQuery( queryText, arrayRowMode = false) {
    const { data, rowsAffected } = await this.driverExecuteQuery({ query: queryText, multiple: true }, arrayRowMode)

    const commands = this.identifyCommands(queryText).map((item) => item.type)

    // Executing only non select queries will not return results.
    // So we "fake" there is at least one result.
    const results = !data.recordsets.length && rowsAffected > 0 ? [[]] : data.recordsets

    return results.map((result, idx) => this.parseRowQueryResult(result, rowsAffected, commands[idx], result?.columns, arrayRowMode))
  }

  query(queryText) {
    const queryRequest = null
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    return {
      execute() {
        return self.runWithConnection(async () => {
          try {
            return await self.executeQuery(queryText, true)
          } catch (err) {
            if (err.code === mmsqlErrors.CANCELED) {
              err.sqlectronError = 'CANCELED_BY_USER';
            }

            throw err
          }
        });
      },

      async cancel() {
        if (!queryRequest) {
          throw new Error('Query not ready to be canceled')
        }

        queryRequest.cancel()
      },
    }
  }

  async selectTop(table, offset, limit, orderBy, filters, schema, selects = ['*']) {
    this.logger().debug("filters", filters)
    const query = await this.selectTopSql(table, offset, limit, orderBy, filters, schema, selects)
    this.logger().debug(query)

    const result = await this.driverExecuteQuery({ query })
    this.logger().debug(result)
    return {
      result: result.data.recordset,
      fields: Object.keys(result.data.recordset[0] || {})
    }
  }

  async selectTopSql(
    table,
    offset,
    limit,
    orderBy,
    filters,
    schema,
    selects
  ) {
    const version = await this.getVersion();
    return version.supportOffsetFetch
      ? this.genSelectNew(table, offset, limit, orderBy, filters, schema, selects)
      : this.genSelectOld(table, offset, limit, orderBy, filters, schema, selects);
  }

  async listTableTriggers(table, schema) {
    // SQL Server does not have information_schema for triggers, so other way around
    // is using sp_helptrigger stored procedure to fetch triggers related to table
    const sql = `EXEC sp_helptrigger '${escapeString(schema)}.${escapeString(table)}'`;

    const { data } = await this.driverExecuteQuery({ query: sql });

    return data.recordset.map((row) => {
      const update = row.isupdate === 1 ? 'UPDATE' : null
      const del = row.isdelete === 1 ? 'DELETE': null
      const insert = row.isinsert === 1 ? 'INSERT' : null
      const instead = row.isinsteadof === 1 ? 'INSEAD_OF' : null

      const manips = [update, del, insert, instead].filter((f) => f).join(", ")

      return {
        name: row.trigger_name,
        timing: row.isafter === 1 ? 'AFTER' : 'BEFORE',
        manipulation: manips,
        action: null,
        condition: null,
        table, schema
      }
    })
  }

  async getPrimaryKeys(database, table, schema) {
    this.logger().debug('finding foreign key for', database, table)
    const sql = `
    SELECT COLUMN_NAME, ORDINAL_POSITION
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE OBJECTPROPERTY(OBJECT_ID(CONSTRAINT_SCHEMA + '.' + QUOTENAME(CONSTRAINT_NAME)), 'IsPrimaryKey') = 1
    AND TABLE_NAME = ${this.wrapValue(table)} AND TABLE_SCHEMA = ${this.wrapValue(schema)}
    `
    const { data } = await this.driverExecuteQuery({ query: sql})
    if (!data.recordset || data.recordset.length === 0) return []

    return data.recordset.map((r) => ({
      columnName: r.COLUMN_NAME,
      position: r.ORDINAL_POSITION
    }))
  }

  async getPrimaryKey(database, table, schema) {
    const res = await this.getPrimaryKeys(database, table, schema)
    return res.length === 1 ? res[0].columnName : null
  }

  async listTableIndexes(_db, table, schema = this.defaultSchema()): Promise<TableIndex[]> {
    const sql = `
      SELECT

      t.name as table_name,
      s.name as schema_name,
      ind.name as index_name,
      ind.index_id as index_id,
      ic.index_column_id as column_id,
      col.name as column_name,
      ic.is_descending_key as is_descending,
      ind.is_unique as is_unique,
      ind.is_primary_key as is_primary

      FROM
          sys.indexes ind
      INNER JOIN
          sys.index_columns ic ON  ind.object_id = ic.object_id and ind.index_id = ic.index_id
      INNER JOIN
          sys.columns col ON ic.object_id = col.object_id and ic.column_id = col.column_id
      INNER JOIN
          sys.tables t ON ind.object_id = t.object_id
      INNER JOIN
          sys.schemas s on t.schema_id = s.schema_id
      WHERE
          ind.is_unique_constraint = 0
          AND t.is_ms_shipped = 0
          AND t.name = '${escapeString(table)}'
          AND s.name = '${escapeString(schema)}'
      ORDER BY
          t.name, ind.name, ind.index_id, ic.is_included_column, ic.key_ordinal;
    `

    const { data } = await this.driverExecuteQuery({ query: sql })

    const grouped = _.groupBy(data.recordset, 'index_name')

    const result = Object.keys(grouped).map((indexName) => {
      const blob = grouped[indexName]
      const unique = blob[0].is_unique
      const id = blob[0].index_id
      const primary = blob[0].is_primary
      const columns = _.sortBy(blob, 'column_id').map((column) => {
        return {
          name: column.column_name,
          order: column.is_descending ? 'DESC' : 'ASC'
        }
      })
      return {
        table, schema, id, name: indexName, unique, primary, columns
      }
    })

    return _.sortBy(result, 'id') as TableIndex[]
  }

  async getTableProperties(table, schema = this.defaultSchema()): Promise<TableProperties> {
    const triggers = await this.listTableTriggers(table, schema)
    const indexes = await this.listTableIndexes(table, schema)
    const description = await this.getTableDescription(table, schema)
    const sizeQuery = `EXEC sp_spaceused N'${escapeString(schema)}.${escapeString(table)}'; `
    const { data }  = await this.driverExecuteQuery({ query: sizeQuery })
    const row = data.recordset ? data.recordset[0] || {} : {}
    const relations = await this.getTableKeys(null, table, schema)
    return {
      size: bytesParse(row.data),
      indexSize: bytesParse(row.index_size),
      triggers,
      indexes,
      description,
      relations
    }
  }

  async getTableKeys(_, table, schema) {
    const sql = `
      SELECT
          name = FK.CONSTRAINT_NAME,
          from_schema = PK.TABLE_SCHEMA,
          from_table = FK.TABLE_NAME,
          from_column = CU.COLUMN_NAME,
          to_schema = PK.TABLE_SCHEMA,
          to_table = PK.TABLE_NAME,
          to_column = PT.COLUMN_NAME,
          constraint_name = C.CONSTRAINT_NAME,
          on_update = C.UPDATE_RULE,
          on_delete = C.DELETE_RULE
      FROM
          INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS C
      INNER JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS FK
          ON C.CONSTRAINT_NAME = FK.CONSTRAINT_NAME
      INNER JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS PK
          ON C.UNIQUE_CONSTRAINT_NAME = PK.CONSTRAINT_NAME
      INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE CU
          ON C.CONSTRAINT_NAME = CU.CONSTRAINT_NAME
      INNER JOIN (
                  SELECT
                      i1.TABLE_NAME,
                      i2.COLUMN_NAME
                  FROM
                      INFORMATION_SCHEMA.TABLE_CONSTRAINTS i1
                  INNER JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE i2
                      ON i1.CONSTRAINT_NAME = i2.CONSTRAINT_NAME
                  WHERE
                      i1.CONSTRAINT_TYPE = 'PRIMARY KEY'
                ) PT
          ON PT.TABLE_NAME = PK.TABLE_NAME

      WHERE FK.TABLE_NAME = ${this.wrapValue(table)} AND FK.TABLE_SCHEMA =${this.wrapValue(schema)}
    `;

    const { data } = await this.driverExecuteQuery({ query: sql });

    const result = data.recordset.map((row) => ({
      constraintName: row.name,
      toTable: row.to_table,
      toColumn: row.to_column,
      toSchema: row.to_schema,
      fromSchema: row.from_schema,
      fromTable: row.from_table,
      fromColumn: row.from_column,
      onUpdate: row.on_update,
      onDelete: row.on_delete
    }));
    this.logger().debug("tableKeys result", result)
    return result
  }

  async selectTopStream(db, table, orderBy, filters, chunkSize, schema, selects = ['*']) {
    const query = this.genSelectNew(table, null, null, orderBy, filters, schema, selects)
    const columns = await this.listTableColumns(db, table, schema)
    const rowCount = await this.getTableLength(table, schema)

    return {
      totalRows: Number(rowCount),
      columns,
      cursor: new SqlServerCursor(this.connection, query, chunkSize)
    }
  }

  async getTableLength(table, schema) {
    const countQuery = this.genCountQuery(table, [], schema)
    const countResults = await this.driverExecuteQuery({ query: countQuery})
    const rowWithTotal = countResults.data.recordset.find((row) => { return row.total })
    const totalRecords = rowWithTotal ? rowWithTotal.total : 0
    return totalRecords
  }

  async dropElement (elementName, typeOfElement, schema = 'dbo') {
    const sql = `DROP ${D.wrapLiteral(typeOfElement)} ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(elementName)}`
    await this.driverExecuteQuery({ query: sql })
  }

  async listDatabases(filter) {
    const databaseFilter = buildDatabaseFilter(filter, 'name');
    const sql = `
      SELECT name
      FROM sys.databases
      ${databaseFilter ? `AND ${databaseFilter}` : ''}
      ORDER BY name
    `

    const { data } = await this.driverExecuteQuery({ query: sql })

    return data.recordset.map((row) => row.name)
  }

  /*
    From https://docs.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql?view=sql-server-ver16&tabs=sqlpool:
    Collation name can be either a Windows collation name or a SQL collation name. If not specified, the database is assigned the default collation of the instance of SQL Server
    Having this, going to keep collations at the default because there are literally thousands of options
  */
  async createDatabase(databaseName) {
    const sql = `create database ${this.wrapIdentifier(databaseName)}`;
    await this.driverExecuteQuery({ query: sql })
  }

  createDatabaseSQL(): string {
    throw new Error("Method not implemented.");
  }

  // should figure out how to not require this because it's being a butt
  protected async rawExecuteQuery() {
    return []
  }

  async truncateAllTables() {
    const schema = await this.getSchema()

    const sql = `
      SELECT table_name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE table_schema = '${schema}'
      AND table_type NOT LIKE '%VIEW%'
    `;

    const { data } = await this.driverExecuteQuery({ query: sql });

    const truncateAll = data.recordset.map((row) => `
      DELETE FROM ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(row.table_name)}
      DBCC CHECKIDENT ('${schema}.${row.table_name}', RESEED, 0);
    `).join('');

    await this.driverExecuteQuery({ query: truncateAll, multiple: true });
  }

  async truncateElement (elementName, typeOfElement, schema = 'dbo') {
    const sql = `TRUNCATE ${D.wrapLiteral(typeOfElement)} ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(elementName)}`
    await this.driverExecuteQuery({ query: sql })
  }

  async duplicateTable(tableName, duplicateTableName, schema = 'dbo') {
    const sql = this.duplicateTableSql(tableName, duplicateTableName, schema)

    await this.driverExecuteQuery({ query: sql })
  }

  duplicateTableSql(tableName, duplicateTableName, schema) {
    return `SELECT * INTO ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(duplicateTableName)} FROM ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(tableName)}`
  }

  async alterTableSql(changes) {
    const { table, schema } = changes
    const columns = await this.listTableColumns(null, table, schema)
    const defaultConstraints = await this.listDefaultConstraints(table, schema)
    const builder = new SqlServerChangeBuilder(table, schema, columns, defaultConstraints)
    return builder.alterTable(changes)
  }

  async alterTable(changes) {
    const query = await this.alterTableSql(changes)
    await this.executeWithTransaction({ query })
  }

  // alterIndexSql(payload) {
  //   const { table, schema, additions, drops } = payload
  //   const changeBuilder = new SqlServerChangeBuilder(table, schema, [], [])
  //   const newIndexes = changeBuilder.createIndexes(additions)
  //   const droppers = changeBuilder.dropIndexes(drops)
  //   return [newIndexes, droppers].filter((f) => !!f).join(";")
  // }

  async alterIndex(payload) {
    const sql = this.alterIndexSql(payload)
    await this.executeWithTransaction({ query: sql })
  }

  async applyChanges(changes) {
    const results = []
    let sql = ['SET XACT_ABORT ON', 'BEGIN TRANSACTION']

    try {
      if (changes.inserts) {
        sql = sql.concat(buildInsertQueries(this.knex, changes.inserts))
      }

      if (changes.updates) {
        sql = sql.concat(buildUpdateQueries(this.knex, changes.updates))
      }

      if (changes.deletes) {
        sql = sql.concat(buildDeleteQueries(this.knex, changes.deletes))
      }

      sql.push('COMMIT')

      await this.driverExecuteQuery({ query: sql.join(';')})

      if (changes.updates) {
        const selectQueries = buildSelectQueriesFromUpdates(this.knex, changes.updates)
        for (let index = 0; index < selectQueries.length; index++) {
          const element = selectQueries[index];
          const r = await this.driverExecuteQuery(element)
          if (r.data[0]) results.push(r.data[0])
        }
      }
    } catch (ex) {
      log.error("query exception: ", ex)
      throw ex
    }

    return results
  }

  async listMaterializedViewColumns() {
    return await []
  }

  async listViews(filter) {
    const schemaFilter = buildSchemaFilter(filter, 'table_schema');
    const sql = `
      SELECT
        table_schema,
        table_name
      FROM INFORMATION_SCHEMA.VIEWS
      ${schemaFilter ? `WHERE ${schemaFilter}` : ''}
      ORDER BY table_schema, table_name
    `

    const { data } = await this.driverExecuteQuery({ query: sql })

    return data.recordset.map((item) => ({
      schema: item.table_schema,
      name: item.table_name,
    }))
  }

  async listMaterializedViews() {
    // const schemaFilter = buildSchemaFilter(filter, '')
    // TODO: materialized views in SQL server
    return []
  }

  async listRoutines(filter) {
    const schemaFilter = buildSchemaFilter(filter, 'r.routine_schema');
    const sql = `
      SELECT
        r.specific_name as id,
        r.routine_schema as routine_schema,
        r.routine_name as name,
        r.routine_type as routine_type,
        r.data_type as data_type
      FROM INFORMATION_SCHEMA.ROUTINES r
      where r.routine_schema not in ('sys', 'information_schema',
                                  'mysql', 'performance_schema', 'INFORMATION_SCHEMA')
      ${schemaFilter ? `AND ${schemaFilter}` : ''}
      ORDER BY routine_schema, routine_name
    `;

    const paramsSQL = `
      select
          r.routine_schema as routine_schema,
          r.specific_name as specific_name,
          p.parameter_name as parameter_name,
          p.character_maximum_length as char_length,
          p.data_type as data_type
    from INFORMATION_SCHEMA.ROUTINES r
    left join INFORMATION_SCHEMA.PARAMETERS p
              on p.specific_schema = r.routine_schema
              and p.specific_name = r.specific_name
    where r.routine_schema not in ('sys', 'information_schema',
                                  'mysql', 'performance_schema', 'INFORMATION_SCHEMA')
      ${schemaFilter ? `AND ${schemaFilter}` : ''}

        AND p.parameter_mode = 'IN'
    order by r.routine_schema,
            r.specific_name,
            p.ordinal_position;

    `

    const { data } = await this.driverExecuteQuery({ query: sql });
    const paramsResult = await this.driverExecuteQuery({ query: paramsSQL })
    const grouped = _.groupBy(paramsResult.data.recordset, 'specific_name')

    return data.recordset.map((row) => {
      const params = grouped[row.id] || []
      return {
        schema: row.routine_schema,
        name: row.name,
        type: row.routine_type ? row.routine_type.toLowerCase() : 'function',
        returnType: row.data_type,
        id: row.id,
        routineParams: params.map((p) => {
          return {
            name: p.parameter_name,
            type: p.data_type,
            length: p.char_length || undefined
          }
        })
      }
    })
  }

  async listSchemas(filter) {
    const schemaFilter = buildSchemaFilter(filter);
    const sql = `
      SELECT schema_name
      FROM INFORMATION_SCHEMA.SCHEMATA
      ${schemaFilter ? `WHERE ${schemaFilter}` : ''}
      ORDER BY schema_name
    `

    const { data } = await this.driverExecuteQuery({ query: sql })

    return data.recordset.map((row) => row.schema_name)
  }

  async getTableReferences(table) {
    const sql = `
      SELECT OBJECT_NAME(referenced_object_id) referenced_table_name
      FROM sys.foreign_keys
      WHERE parent_object_id = OBJECT_ID('${table}')
    `

    const { data } = await this.driverExecuteQuery({ query: sql })

    return data.recordset.map((row) => row.referenced_table_name)
  }

  async queryStream(_, query, chunkSize) {
    return {
      totalRows: undefined,
      columns: undefined,
      cursor: new SqlServerCursor(this.connection, query, chunkSize),
    }
  }

  // async getInsertQuery(database, tableInsert) {
  //   const columns = await this.listTableColumns(database, tableInsert.table, tableInsert.schema)
  //   return buildInsertQuery(this.knex, tableInsert, columns, _.toString)
  // }

  getQuerySelectTop(table, limit) {
    return `SELECT TOP ${limit} * FROM ${this.wrapIdentifier(table)}`;
  }

  async getTableCreateScript(table) {
    // Reference http://stackoverflow.com/a/317864
    const sql = `
      SELECT  ('CREATE TABLE ' + so.name + ' (' +
        CHAR(13)+CHAR(10) + REPLACE(o.list, '&#x0D;', CHAR(13)) +
        ')' + CHAR(13)+CHAR(10) +
        CASE WHEN tc.constraint_name IS NULL THEN ''
             ELSE + CHAR(13)+CHAR(10) + 'ALTER TABLE ' + so.Name +
             ' ADD CONSTRAINT ' + tc.constraint_name  +
             ' PRIMARY KEY ' + '(' + LEFT(j.list, Len(j.list)-1) + ')'
        END) AS createtable
      FROM sysobjects so
      CROSS APPLY
        (SELECT
          '  ' + column_name + ' ' +
          data_type +
          CASE data_type
              WHEN 'sql_variant' THEN ''
              WHEN 'text' THEN ''
              WHEN 'ntext' THEN ''
              WHEN 'xml' THEN ''
              WHEN 'decimal' THEN '(' + cast(numeric_precision AS varchar) + ', '
                    + cast(numeric_scale AS varchar) + ')'
              ELSE coalesce('('+ CASE WHEN character_maximum_length = -1
                    THEN 'MAX'
                    ELSE cast(character_maximum_length AS varchar)
                  END + ')','')
            END + ' ' +
            CASE WHEN EXISTS (
              SELECT id FROM syscolumns
              WHERE object_name(id)=so.name
              AND name=column_name
              AND columnproperty(id,name,'IsIdentity') = 1
            ) THEN
              'IDENTITY(' +
              cast(ident_seed(so.name) AS varchar) + ',' +
              cast(ident_incr(so.name) AS varchar) + ')'
            ELSE ''
            END + ' ' +
             (CASE WHEN UPPER(IS_NULLABLE) = 'NO'
                   THEN 'NOT '
                   ELSE ''
            END ) + 'NULL' +
            CASE WHEN INFORMATION_SCHEMA.COLUMNS.column_default IS NOT NULL
                 THEN ' DEFAULT '+ INFORMATION_SCHEMA.COLUMNS.column_default
                 ELSE ''
            END + ',' + CHAR(13)+CHAR(10)
         FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = so.name
         ORDER BY ordinal_position
         FOR XML PATH('')
      ) o (list)
      LEFT JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      ON  tc.table_name       = so.name
      AND tc.constraint_type  = 'PRIMARY KEY'
      CROSS APPLY
          (SELECT column_name + ', '
           FROM   INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           WHERE  kcu.constraint_name = tc.constraint_name
           ORDER BY ordinal_position
           FOR XML PATH('')
          ) j (list)
      WHERE   xtype = 'U'
      AND name    NOT IN ('dtproperties')
      AND so.name = '${table}'
    `

    const { data } = await this.driverExecuteQuery({ query: sql })

    return data.recordset.map((row) => row.createtable)
  }

  async getViewCreateScript(view) {
    const sql = `SELECT OBJECT_DEFINITION (OBJECT_ID('${view}')) AS ViewDefinition;`;

    const { data } = await this.driverExecuteQuery({ query: sql });

    return data.recordset.map((row) => row.ViewDefinition);
  }

  async getMaterializedViewCreateScripts() {
    return await []
  }

  async getRoutineCreateScript(routine) {
    const sql = `
      SELECT routine_definition
      FROM INFORMATION_SCHEMA.ROUTINES
      WHERE routine_name = '${routine}'
    `

    const { data } = await this.driverExecuteQuery({ query: sql })

    return data.recordset.map((row) => row.routine_definition)
  }

  async setTableDescription(table, desc, schema) {
    const existingDescription = await this.getTableDescription(table, schema)
    const f = existingDescription ? 'sp_updateextendedproperty' : 'sp_addextendedproperty'
    const sql = `
    EXEC ${f}
      @name = N'MS_Description',
      @value = N${D.escapeString(desc, true)},
      @level0type = N'SCHEMA', @level0name = ${D.wrapIdentifier(schema)},
      @level1type = N'TABLE',  @level1name = ${D.wrapIdentifier(table)};
    `
    await this.executeQuery(sql)
    return ''
  }

  async alterRelation(payload) {
    const query = this.alterRelationSql(payload)
    await this.executeWithTransaction({ query });
  }

  async importData(insertSQL) {
    return await this.executeWithTransaction({ query: insertSQL })
  }

  getImportSQL (importedData, isTruncate) {
    const { schema, table } = importedData[0]
    const queries = []
    // IDENTITY_INSERT is used in case there is a guid getting created by the database, trying to import something into an "IDENTITY" column would fail
    // https://stackoverflow.com/questions/1334012/cannot-insert-explicit-value-for-identity-column-in-table-table-when-identity/
    queries.push(`SET IDENTITY_INSERT ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(table)} ON`)
    if (isTruncate) {
      queries.push(`TRUNCATE TABLE ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(table)}`)
    }

    queries.push(buildInsertQueries(this.knex, importedData).join(';'))
    queries.push(`SET IDENTITY_INSERT ${this.wrapIdentifier(schema)}.${this.wrapIdentifier(table)} OFF`)
    return joinQueries(queries)
  }

  /* helper functions and settings below! */

  async connect(): Promise<void> {
    this.dbConfig = this.configDatabase(this.server, this.database)
    this.logger().debug('create driver client for mmsql with config %j', this.dbConfig);
    this.version = await this.getVersion()
    return
  }

  async disconnect(): Promise<void> {
    const connection = await new ConnectionPool(this.connection);
    connection.close();
  }

  async listCharsets() {
    return await []
  }

  getDefaultCharset() {
    return null
  }

  async listCollations() {
    return await []
  }

  supportedFeatures() {
    return {
      customRoutines: true,
      comments: true,
      properties: true,
      partitions: false,
      editPartitions: false,
      backups: false,
      backDirFormat: false,
      restore: false
    }
  }

  applyChangesSql(changes): string {
    return applyChangesSql(changes, this.knex)
  }

  wrapIdentifier(value) {
    if (_.isString(value)) {
      return (value !== '*' ? `[${value.replace(/\[/g, '[')}]` : '*');
    } return value
  }

  getBuilder(table: string, schema?: string) {
    return new SqlServerChangeBuilder(table, schema, [], [])
  }

  private async executeWithTransaction(queryArgs) {
    try {
      const query = joinQueries(['SET XACT_ABORT ON', 'BEGIN TRANSACTION', queryArgs.query, 'COMMIT'])
      await this.driverExecuteQuery({ ...queryArgs, query })
    } catch (ex) {
      this.logger().error(ex)
      throw ex
    }
  }

  private async driverExecuteQuery(queryArgs: any, arrayRowMode = false) {
    this.logger().info('RUNNING', queryArgs)
    const query = _.isObject(queryArgs)? (queryArgs as {query: string}).query : queryArgs
    identify(query || '', { strict: false, dialect: 'mssql' })

    const runQuery = async (connection) => {
      const request = connection.request()
      request.arrayRowMode = arrayRowMode
      const data = await request.query(queryArgs.query)
      const rowsAffected = _.sum(data.rowsAffected)
      return { request, data, rowsAffected }
    };

    return this.connection
      ? runQuery(this.connection)
      : this.runWithConnection(runQuery)
  }

  private async runWithConnection(run) {
    const connection = await new ConnectionPool(this.dbConfig).connect()
    this.connection = connection
    this.connection.dbConfig = this.dbConfig
    return run(this.connection)
  }

  private parseFields(data, columns) {
    if (columns && _.isArray(columns)) {
      return columns.map((c, idx) => {
        return {
          id: `c${idx}`,
          name: c.name
        }
      })
    } else {
      return Object.keys(data[0] || {}).map((name) => ({ name, id: name }))
    }
  }

  private parseRowQueryResult(data, rowsAffected, command, columns, arrayRowMode = false) {
    // Fallback in case the identifier could not reconize the command
    // eslint-disable-next-line
    const isSelect = !!(data.length || rowsAffected === 0)
    const fields = this.parseFields(data, columns)
    const fieldIds = fields.map(f => f.id)
    return {
      command: command || (isSelect && 'SELECT'),
      rows: arrayRowMode ? data.map(r => _.zipObject(fieldIds, r)) : data,
      fields: fields,
      rowCount: data.length,
      affectedRows: rowsAffected,
    }
  }

  private identifyCommands(queryText) {
    try {
      return identify(queryText);
    } catch (err) {
      return [];
    }
  }

  private configDatabase(server, database): Promise<DatabaseClient> {
    const config:any = {
      user: server.config.user,
      password: server.config.password,
      server: server.config.host,
      database: database.database,
      port: server.config.port,
      requestTimeout: Infinity,
      appName: server.config.applicationName || 'beekeeperstudio',
      pool: {
        max: 10,
      }
    };
    if (server.config.domain) {
      config.domain = server.config.domain
    }

    if (server.sshTunnel) {
      config.server = server.config.localHost;
      config.port = server.config.localPort;
    }

    config.options = { trustServerCertificate: server.config.trustServerCertificate }

    if (server.config.ssl) {
      const options: any = {
        encrypt: server.config.ssl,
        cryptoCredentialsDetails: {}
      }

      if (server.config.sslCaFile) {
        options.cryptoCredentialsDetails.ca = readFileSync(server.config.sslCaFile);
      }

      if (server.config.sslCertFile) {
        options.cryptoCredentialsDetails.cert = readFileSync(server.config.sslCertFile);
      }

      if (server.config.sslKeyFile) {
        options.cryptoCredentialsDetails.key = readFileSync(server.config.sslKeyFile);
      }


      if (server.config.sslCaFile && server.config.sslCertFile && server.config.sslKeyFile) {
        // trust = !reject
        // mssql driver reverses this setting for no obvious reason
        // other drivers simply pass through to the SSL library.
        options.trustServerCertificate = !server.config.sslRejectUnauthorized
      }

      config.options = options;
    }

    return config;
  }

  private genSelectOld(table, offset, limit, orderBy, filters, schema, selects) {
    const selectString = selects.map((s) => this.wrapIdentifier(s)).join(", ")
    const orderByString = this.genOrderByString(orderBy)
    const filterString = _.isString(filters) ? `WHERE ${filters}` : this.buildFilterString(filters)
    const lastRow = offset + limit
    const schemaString = schema ? `${this.wrapIdentifier(schema)}.` : ''

    const query = `
      WITH CTE AS
      (
          SELECT ${selectString}
                , ROW_NUMBER() OVER (${orderByString}) as RowNumber
          FROM ${schemaString}${this.wrapIdentifier(table)}
          ${filterString}
      )
      SELECT *
            -- get the total records so the web layer can work out
            -- how many pages there are
            , (SELECT COUNT(*) FROM CTE) AS TotalRecords
      FROM CTE
      WHERE RowNumber BETWEEN ${offset} AND ${lastRow}
      ORDER BY RowNumber ASC
    `
    return query
  }

  private genSelectNew(table, offset, limit, orderBy, filters, schema, selects) {
    const filterString = _.isString(filters) ? `WHERE ${filters}` : this.buildFilterString(filters)

    const orderByString = this.genOrderByString(orderBy)
    const schemaString = schema ? `${this.wrapIdentifier(schema)}.` : ''

    const selectSQL = `SELECT ${selects.map((s) => this.wrapIdentifier(s)).join(", ")}`
    const baseSQL = `
      FROM ${schemaString}${this.wrapIdentifier(table)}
      ${filterString}
    `

    const offsetString = (_.isNumber(offset) && _.isNumber(limit)) ?
      `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY` : ''


    const query = `
      ${selectSQL} ${baseSQL}
      ${orderByString}
      ${offsetString}
      `
    return query
  }

  private buildFilterString(filters) {
    let filterString = ""
    if (filters && filters.length > 0) {
      const allFilters = filters.map((item) => {
        const wrappedValue = _.isArray(item.value) ?
          `(${item.value.map((v) => D.escapeString(v, true)).join(',')})` :
          D.escapeString(item.value, true)

        return `${this.wrapIdentifier(item.field)} ${item.type.toUpperCase()} ${wrappedValue}`
      })
      filterString = "WHERE " + joinFilters(allFilters, filters)
    }
    return filterString
  }

  private genOrderByString(orderBy) {
    if (!orderBy) return ""

    let orderByString = "ORDER BY (SELECT NULL)"
    if (orderBy && orderBy.length > 0) {
      orderByString = "ORDER BY " + (orderBy.map((item: {field: any, dir: any}) => {
        if (_.isObject(item)) {
          return `${this.wrapIdentifier(item.field)} ${item.dir.toUpperCase()}`
        } else {
          return this.wrapIdentifier(item)
        }
      })).join(",")
    }
    return orderByString
  }

  private wrapValue(value) {
    return `'${value.replaceAll(/'/g, "''")}'`
  }

  private genCountQuery(table, filters, schema) {
    const filterString = _.isString(filters) ? `WHERE ${filters}` : this.buildFilterString(filters)

    const schemaString = schema ? `${this.wrapIdentifier(schema)}.` : ''

    const baseSQL = `
     FROM ${schemaString}${this.wrapIdentifier(table)}
     ${filterString}
    `
    const countQuery = `
      select count(*) as total ${baseSQL}
    `
    return countQuery
  }

  private async getSchema() {
    const sql = 'SELECT schema_name() AS \'schema\''
    const { data } = await this.driverExecuteQuery({ query: sql })

    return data.recordsets[0].schema
  }

  private async listDefaultConstraints(table, schema) {
    const sql = `
      -- returns name of a column's default value constraint
      SELECT
        all_columns.name as columnName,
        tables.name as tableName,
        schemas.name as schemaName,
        default_constraints.name as name
      FROM
        sys.all_columns
          INNER JOIN
        sys.tables
          ON all_columns.object_id = tables.object_id

          INNER JOIN
        sys.schemas
          ON tables.schema_id = schemas.schema_id

          INNER JOIN
        sys.default_constraints
          ON all_columns.default_object_id = default_constraints.object_id
      WHERE
        schemas.name = ${D.escapeString(schema || this.defaultSchema(), true)}
        AND tables.name = ${D.escapeString(table, true)}
    `
    const { data } = await this.driverExecuteQuery({ query: sql})
    return data.recordset.map((d) => {
      return {
        column: d.columnName,
        table: d.tableName,
        schema: d.schemaName,
        name: d.name
      }
    })
  }

  private async getTableDescription(table, schema = this.defaultSchema()) {
    const query = `SELECT *
      FROM fn_listextendedproperty (
        'MS_Description',
        'schema',
        '${escapeString(schema)}',
        'table',
        '${escapeString(table)}',
        default,
      default);
    `
    const data = await this.driverExecuteQuery({ query })
    if (!data || !data.recordset || data.recordset.length === 0) {
      return null
    }
    return data.recordset[0].MS_Description
  }
}

export default async function (server: IDbConnectionServer, database: IDbConnectionDatabase) {
  const client = new SQLServerClient(server, database);
  await client.connect();

  return client;
}
