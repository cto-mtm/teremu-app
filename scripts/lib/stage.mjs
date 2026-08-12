/**
 * Tiny stage logger for the repo's node scripts (deploy gate, etc.):
 * a timestamped banner when a stage starts, elapsed seconds when it ends —
 * so a long multi-stage run always shows what it's doing right now.
 */
const t = () => new Date().toLocaleTimeString('en-GB', { hour12: false })

export function stage(title) {
  const started = Date.now()
  console.log('\n────────────────────────────────────────────────────────')
  console.log(`▶ ${t()}  ${title}`)
  console.log('────────────────────────────────────────────────────────')
  return {
    done(note = 'done') {
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      console.log(`✔ ${t()}  ${title} — ${note} (${secs}s)`)
    },
  }
}
