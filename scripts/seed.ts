/**
 * Idempotent seeder: loads a project + personas definition from a JSON file
 * and inserts anything not already present (matched by name).
 *
 * Usage: npx tsx scripts/seed.ts <path-to-seed.json>
 * JSON shape: { project: {name, applicationDomain?, targetPopulation?},
 *               personas?: [{name, demographics, biography?, renderingStyle?, provenance?}],
 *               questionnaires?: [{name, questions: [{text, options, scaleType?, scaleDirection?}]}] }
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createDb } from '../src/db.js'

const seedSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    applicationDomain: z.string().optional(),
    targetPopulation: z.string().optional()
  }),
  personas: z
    .array(
      z.object({
        name: z.string().min(1),
        demographics: z.record(z.unknown()),
        biography: z.string().optional(),
        renderingStyle: z.enum(['bulleted_profile', 'natural_language_sentence']).default('bulleted_profile'),
        provenance: z.record(z.unknown()).optional()
      })
    )
    .default([]),
  questionnaires: z
    .array(
      z.object({
        name: z.string().min(1),
        isCalibrationProbe: z.boolean().optional(),
        questions: z
          .array(
            z.object({
              text: z.string().min(1),
              options: z.array(z.string().min(1)).min(2).max(26),
              // A typo here would silently revert a multi-select question to sum-to-1
          // elicitation, so the value is constrained rather than free text.
          scaleType: z.enum(['single_choice', 'multi_choice', 'frequency', 'ordinal', 'categorical']).default('categorical'),
              scaleDirection: z.enum(['ascending', 'descending']).default('ascending')
            }).catchall(z.unknown())
          )
          .min(1)
      })
    )
    .default([])
})

const seedPath = process.argv[2]
if (!seedPath) {
  process.stderr.write('Usage: npx tsx scripts/seed.ts <path-to-seed.json>\n')
  process.exit(1)
}

const seed = seedSchema.parse(JSON.parse(readFileSync(seedPath, 'utf8')))
const db = createDb(process.env['DATABASE_PATH'] ?? './data/asys.sqlite')

const existingProject = db
  .prepare('SELECT id FROM projects WHERE name = ?')
  .get(seed.project.name) as { id: string } | undefined
const projectId = existingProject?.id ?? randomUUID()
if (!existingProject) {
  db.prepare('INSERT INTO projects (id, name, application_domain, target_population) VALUES (?,?,?,?)').run(
    projectId, seed.project.name, seed.project.applicationDomain ?? null, seed.project.targetPopulation ?? null
  )
  process.stdout.write(`Created project "${seed.project.name}" (${projectId})\n`)
} else {
  process.stdout.write(`Project "${seed.project.name}" already exists (${projectId})\n`)
}

let created = 0
for (const persona of seed.personas) {
  const exists = db
    .prepare('SELECT id FROM personas WHERE project_id = ? AND name = ?')
    .get(projectId, persona.name)
  if (exists) continue
  db.prepare(
    'INSERT INTO personas (id, project_id, name, demographics_json, biography, rendering_style, provenance_json) VALUES (?,?,?,?,?,?,?)'
  ).run(
    randomUUID(), projectId, persona.name, JSON.stringify(persona.demographics),
    persona.biography ?? null, persona.renderingStyle,
    persona.provenance ? JSON.stringify(persona.provenance) : null
  )
  created++
}
process.stdout.write(`Personas: ${created} created, ${seed.personas.length - created} already present\n`)

let qCreated = 0
for (const questionnaire of seed.questionnaires) {
  const isCalibrationProbe = questionnaire.isCalibrationProbe ?? seed.project.name === 'Modell-baseline próba'
  const exists = db
    .prepare('SELECT id FROM questionnaires WHERE project_id = ? AND name = ?')
    .get(projectId, questionnaire.name) as { id: string } | undefined
  if (exists) {
    if (isCalibrationProbe) {
      db.prepare('UPDATE questionnaires SET is_calibration_probe = 1 WHERE id = ?').run(exists.id)
    }
    continue
  }
  const qid = randomUUID()
  db.exec('BEGIN')
  try {
    db.prepare('INSERT INTO questionnaires (id, project_id, name, is_calibration_probe) VALUES (?,?,?,?)').run(
      qid, projectId, questionnaire.name, isCalibrationProbe ? 1 : 0
    )
    questionnaire.questions.forEach((q, ord) => {
      const metadata = Object.fromEntries(Object.entries(q).filter(([key]) => key.startsWith('_')))
      db.prepare(
        'INSERT INTO questions (id, questionnaire_id, ord, text, scale_type, options_json, scale_direction, metadata_json) VALUES (?,?,?,?,?,?,?,?)'
      ).run(
        randomUUID(), qid, ord, q.text, q.scaleType, JSON.stringify(q.options), q.scaleDirection,
        Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
      )
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  qCreated++
}
process.stdout.write(`Questionnaires: ${qCreated} created, ${seed.questionnaires.length - qCreated} already present\n`)
