import pg from 'pg';

const { Pool } = pg;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !DATABASE_URL) {
  throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY et DATABASE_URL sont requis');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fetchAllPersons() {
  const pageSize = 1000;
  const persons = [];

  for (let offset = 0; ; offset += pageSize) {
    const url = new URL('/rest/v1/persons', SUPABASE_URL);
    url.searchParams.set('select', '*');
    url.searchParams.set('order', 'id.asc');
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));

    const response = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`
      }
    });

    if (!response.ok) {
      throw new Error(`Lecture Supabase impossible (${response.status}): ${await response.text()}`);
    }

    const rows = await response.json();
    persons.push(...rows);

    if (rows.length < pageSize) break;
  }

  return persons;
}

async function createSchema() {
  const existing = await pool.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'persons'
      AND column_name = 'id'
  `);

  if (existing.rows[0]?.data_type && existing.rows[0].data_type !== 'uuid') {
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM persons');
    if (count.rows[0].count > 0) {
      throw new Error('La table persons existe deja avec un id non UUID et contient des donnees');
    }
    await pool.query('DROP TABLE persons');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS persons (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_name text NOT NULL,
      raw_data jsonb NOT NULL,
      user_id text,
      age integer,
      start_time timestamptz,
      end_time timestamptz,
      pathologie text,
      commentaire text
    )
  `);
}

async function upsertPersons(persons) {
  if (!persons.length) return;

  const columns = [
    'id',
    'person_name',
    'raw_data',
    'user_id',
    'age',
    'start_time',
    'end_time',
    'pathologie',
    'commentaire'
  ];

  const batchSize = 250;

  for (let offset = 0; offset < persons.length; offset += batchSize) {
    const batch = persons.slice(offset, offset + batchSize);
    const values = [];
    const placeholders = batch.map((person, personIndex) => {
      const rowPlaceholders = columns.map((column, columnIndex) => {
        values.push(person[column] ?? null);
        return `$${personIndex * columns.length + columnIndex + 1}`;
      });
      return `(${rowPlaceholders.join(', ')})`;
    });

    await pool.query(
      `
        INSERT INTO persons (${columns.map(column => `"${column}"`).join(', ')})
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (id) DO UPDATE SET
          person_name = EXCLUDED.person_name,
          raw_data = EXCLUDED.raw_data,
          user_id = EXCLUDED.user_id,
          age = EXCLUDED.age,
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          pathologie = EXCLUDED.pathologie,
          commentaire = EXCLUDED.commentaire
      `,
      values
    );

    console.log(`Migrated ${Math.min(offset + batch.length, persons.length)}/${persons.length}`);
  }
}

try {
  await createSchema();
  const persons = await fetchAllPersons();
  await upsertPersons(persons);
  console.log(`Migration terminee: ${persons.length} personne(s) copiee(s).`);
} finally {
  await pool.end();
}
