/** Analyses route — SPEC §6 "Analyses". */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { sendJson, HttpError } from '../lib/http.js'
import { analysisPayload } from '../ai.js'

export function registerAnalysisRoutes(router) {
  router.get('/api/analyses/:id', async ({ req, res, params }) => {
    const user = requireUser(req)
    const db = getDb()
    const row = db.prepare('SELECT * FROM analyses WHERE id = ? AND user_id = ?').get(params.id, user.id)
    if (!row) throw new HttpError(404, 'Analysis not found')
    sendJson(res, 200, { ok: true, analysis: analysisPayload(row) })
  })
}
