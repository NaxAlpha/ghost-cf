const makeKnex = require('knex/lib/knex-builder/make-knex');
const { D1Client } = require('./d1-client.cjs');
function createDatabase() {
  return makeKnex(new D1Client({ client: D1Client }));
}
module.exports = { createDatabase };
