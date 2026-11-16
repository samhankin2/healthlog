/** Model benchmark route — SPEC §6 "Model benchmark" / §7 "Model benchmark". */
import { getDb } from '../db.js'
import { requireUser } from '../auth.js'
import { sendJson } from '../lib/http.js'
import { clampInt } from '../lib/validate.js'
import { buildBench } from '../lib/modelBench.js'

export function registerModelBenchRoutes(router) {
  router.get('/api/model-bench', async ({ req, res, query }) => {
    const user = requireUser(req)
    const days = clampInt(query.get('days'), 1, 3650, 90)
    sendJson(res, 200, { ok: true, ...buildBench(getDb(), user.id, { days }) })
  })
}
