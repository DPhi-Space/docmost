import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('shares').addColumn('slug', 'varchar').execute();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS shares_slug_lower_workspace_unique
    ON shares (LOWER(slug), workspace_id)
    WHERE slug IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .dropIndex('shares_slug_lower_workspace_unique')
    .ifExists()
    .execute();

  await db.schema.alterTable('shares').dropColumn('slug').execute();
}
