#!/usr/bin/env node

// Second half of `pnpm db:types`: reads generated Supabase types on stdin, applies the corrections
// below, writes the result. Nothing is written unless every correction still applies, so a generator
// that changed shape stops the pipeline instead of silently dropping a correction.
//
// The generator is pinned to 2.117.0, not to the `supabase` devDependency that drives `pnpm db:start`:
// 2.118 and later print "Generated TypeScript is unformatted", and the stack CLI cannot move because a
// newer one rejects this repository's config.toml.

import { writeFileSync } from 'node:fs'

const GENERATOR = 'supabase@2.117.0'

const patches = [
    {
        name: '__InternalSupabase.PostgrestVersion',
        why: [
            `${GENERATOR} does not emit the __InternalSupabase block; the CLI versions that do emit it print`,
            'unformatted TypeScript, which is why this repository stays on 2.117.0. Without the block,',
            "supabase-js falls back to PostgrestVersion '12' and types every client as PostgREST 12:",
            'maxAffected() and spread-on-many selects stop type-checking. The local stack runs',
            'postgrest 14.16 and only the major version is load-bearing, so the literal stays pinned here',
            'instead of being read off a container that differs from one machine to the next.',
        ],
        find: 'export type Database = {\n  public: {\n',
        replace:
            'export type Database = {\n' +
            '  // Allows to automatically instantiate createClient with right options\n' +
            "  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)\n" +
            '  __InternalSupabase: {\n' +
            '    PostgrestVersion: "14.5"\n' +
            '  }\n' +
            '  public: {\n',
    },
    {
        name: 'unseen_runs.slug nullability',
        why: [
            'In supabase/migrations/20261020160000_session_reads.sql the slug column of unseen_runs is',
            "(array_agg(coalesce(n.metadata ->> 'scheduleSlug', n.metadata ->> 'triggerSlug') ...))[1].",
            'Both ->> extractions yield null when the key is absent, so the column is genuinely nullable.',
            'The generator emits non-null for every RETURNS TABLE column because the catalog carries no',
            'nullability for them. apps/ui/lib/notifications/unseen-runs.test.ts depends on the real type.',
        ],
        find:
            '      unseen_runs: {\n' +
            '        Args: { p_workspace_id: number }\n' +
            '        Returns: {\n' +
            '          agent_id: string\n' +
            '          last_at: string\n' +
            '          message: string\n' +
            '          run_count: number\n' +
            '          session_id: string\n' +
            '          slug: string\n',
        replace:
            '      unseen_runs: {\n' +
            '        Args: { p_workspace_id: number }\n' +
            '        Returns: {\n' +
            '          agent_id: string\n' +
            '          last_at: string\n' +
            '          message: string\n' +
            '          run_count: number\n' +
            '          session_id: string\n' +
            '          slug: string | null\n',
    },
]

function fail(message, patch) {
    console.error(`\npatch-db-types: ${message}\n`)
    if (patch) {
        console.error(`  patch: ${patch.name}`)
        for (const line of patch.why) console.error(`  why:   ${line}`)
        console.error('')
        console.error('  Expected to find this text in the generated file:')
        for (const line of patch.find.split('\n')) console.error(`  | ${line}`)
        console.error('')
    }
    console.error(`  The generator may have changed shape, or the database may have. Re-read the patch`)
    console.error(`  above against the current output of \`npx --yes ${GENERATOR} gen types typescript`)
    console.error(`  --local --schema public\` and either re-anchor it or, if the generator now gets this`)
    console.error(`  right on its own, delete it from scripts/patch-db-types.mjs.\n`)
    process.exit(1)
}

const target = process.argv[2]
if (!target) fail('usage: supabase gen types ... | node scripts/patch-db-types.mjs <output-file>')

const generated = await new Promise((resolve, reject) => {
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (input += chunk))
    process.stdin.on('end', () => resolve(input))
    process.stdin.on('error', reject)
})

if (!generated.includes('export type Database = {')) {
    fail(
        'stdin does not look like generated Supabase types. Is the local stack running (`pnpm db:start`)?\n' +
            `  Read ${generated.length} bytes.`,
    )
}

let patched = generated.replace(/\n+$/, '\n')

for (const patch of patches) {
    const occurrences = patched.split(patch.find).length - 1
    if (occurrences === 0) {
        if (patched.includes(patch.replace)) continue
        fail('a patch no longer applies', patch)
    }
    if (occurrences > 1) fail(`a patch matched ${occurrences} times and is no longer unambiguous`, patch)
    patched = patched.replace(patch.find, patch.replace)
}

writeFileSync(target, patched)
console.error(`patch-db-types: wrote ${target} (${patches.length} corrections applied)`)
