const SQLiteQueryCompiler = require('knex/lib/dialects/sqlite3/query/sqlite-querycompiler');

class DurableQueryCompiler extends SQLiteQueryCompiler {
  insert() {
    const insertValues = this.single.insert;
    if (!Array.isArray(insertValues) || insertValues.length < 2) return super.insert();
    const data = this._prepInsert(insertValues);
    if (!data.columns.length) return { sql: '' };
    let sql = `${this.with()}insert into ${this.tableName} (${this.formatter.columnize(data.columns)}) values `;
    // Knex 2.4 emits UNION SELECT for older SQLite versions. Workers supports
    // multi-row VALUES, which avoids its much smaller compound SELECT limit.
    const rows = data.values.map(
      (values) =>
        `(${this.client.parameterize(
          values,
          this.client.valueForUndefined,
          this.builder,
          this.bindingsHolder,
        )})`,
    );
    sql += rows.join(', ');
    const { onConflict, ignore, merge, returning } = this.single;
    if (onConflict && ignore) sql += this._ignore(onConflict);
    else if (onConflict && merge) sql += this._merge(merge.updates, onConflict, insertValues);
    if (returning) sql += this._returning(returning);
    return { sql, returning };
  }
}

module.exports = { DurableQueryCompiler };
