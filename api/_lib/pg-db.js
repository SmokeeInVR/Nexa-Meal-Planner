// Postgres adapter for the sync core (Neon in production).
export function pgDatabase(pool) {
  return {
    blobType: 'BYTEA',
    async query(sql, params) { return (await pool.query(sql, params)).rows; },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: async (sql, params) => (await client.query(sql, params)).rows });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
