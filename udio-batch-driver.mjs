// Standalone batch driver: connects to the Playwriter relay directly (no CLI timeouts/SIGPIPE).
// Records own Udio songs at 4x via the in-page WebAudio tap, saves WAVs to /tmp/udio-songs.
import { connectViaExtension } from 'playwriter'
import fs from 'node:fs'
import path from 'node:path'

const OUT_DIR = '/tmp/udio-songs'
const FAST = 4

const tapNative = `
window.__recState = window.__recState || { tapped: false, recording: false, chunks: [], frames: 0, ended: false, err: null, sr: 0, rms: 0 }
;(function () {
  const st = window.__recState
  if (st.tapped) return
  const el = document.querySelector('audio, video')
  if (!el) return
  try {
    const ctx = new AudioContext()
    const src = ctx.createMediaElementSource(el)
    const sp = ctx.createScriptProcessor(4096, 2, 2)
    src.connect(sp)
    sp.connect(ctx.destination)
    st.frames = st.frames || 0
    sp.onaudioprocess = (stream) => {
      const data = stream.inputBuffer.getChannelData(0)
      let s = 0
      for (let i = 0; i < data.length; i++) s += data[i] * data[i]
      window.__recState.rms = Math.sqrt(s / data.length)
      if (window.__recState.recording) {
        const inBuf = stream.inputBuffer
        const chans = []
        for (let c = 0; c < Math.min(inBuf.numberOfChannels, 2); c++) chans.push(new Float32Array(inBuf.getChannelData(c)))
        window.__recState.frames += data.length
        window.__recState.chunks.push({ at: Date.now(), chans })
      }
    }
    st.tapped = true
    st.type = el.constructor.name
    st.sr = ctx.sampleRate
    try { el.loop = true } catch {}
    el.addEventListener('ended', () => { st.ended = true; st.endedAt = Date.now() })
  } catch (e) {
    st.err = String(e).slice(0, 180)
  }
})()
`.trim()

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await using connection = await connectViaExtension({ tabGroup: 'udio' })
  const context = connection.browser.contexts()[0]
  const page = context.pages().findLast((p) => p.url().startsWith('https://www.udio.com/'))
  if (!page) throw new Error('no udio page')

  // fetch all own songs
  const list = await page.evaluate(async () => {
    const grab = async () => {
      const out = []
      let p = 0
      while (out.length < 500) {
        const r = await fetch(`/api/songs/me?likedOnly=false&publishedOnly=false&includeDisliked=false&onlyTrees=false&searchTerm=&inFolder=&sort=created_at&pageParam=${p}&pageSize=50&readOnly=true`, { credentials: 'include' })
        const j = await r.json()
        const data = j.data || []
        out.push(...data.map((s) => ({ id: s.id, title: s.title, dur: s.duration })))
        if (data.length < 50) break
        p++
      }
      return out
    }
    let r = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try { return await grab() } catch (e) { await new Promise((x) => setTimeout(x, 800)) }
    }
    return []
  }).catch((e) => { console.log('list fetch failed:', String(e).slice(0, 120)); return [] })
  console.log('songs to record:', list.length)
  if (!list.length) process.exit(1)

  let i = 0
  for (const song of list) {
    if (i >= 30) { console.log('stopping after 30 songs this run'); break }
    i++
    const safe = (song.title || 'song').replace(/[^a-zA-Z0-9 ()-]/g, '').trim().replace(/\s+/g, '_').slice(0, 48)
    const outFileWav = path.join(OUT_DIR, `${String(i).padStart(3, '0')}-${safe}.wav`)
    if (fs.existsSync(outFileWav)) { console.log('skip existing', outFileWav); continue }
    const url = `https://www.udio.com/songs/${song.id}`
    console.log(`[${i}/${list.length}]`, safe, Math.round(song.dur || 30) + 's')

    // one fresh tab per song: the SPA reuses its audio element across routes, so a tap
    // left behind by the previous song makes createMediaElementSource throw
    const songPage = await context.newPage()
    try {
      await songPage.goto(url, { waitUntil: 'domcontentloaded' })

      // start playback first: the player creates the audio element lazily
      await songPage.locator('role=button[name="Play"i]').first().click().catch(() => {})
      // wait for the audio element to exist, then attach the tap
      let tapped = false
      let lastAttempt = ''
      for (let t = 0; t < 40; t++) {
        const live = await songPage.evaluate(() => window.__recState?.tapped).catch(() => false)
        if (live) { tapped = true; break }
        const res = await songPage.evaluate(tapNative).catch((e) => { lastAttempt = String(e).slice(0, 80) })
        if (res?.tapped) { tapped = true; break }
        await new Promise((r) => setTimeout(r, 400))
      }
      if (!tapped) throw new Error('tap never attached: ' + await songPage.evaluate(() => {
        const st = window.__recState || {}
        return JSON.stringify({ err: st.err, type: st.type, tapped: st.tapped, media: { audio: document.querySelectorAll('audio').length, video: document.querySelectorAll('video').length, src: document.querySelector('audio, video') ? 'node' : 'none' } })
      }))

      // start playing from 0 at 4x speed (we lose the opening moments that already played)
      const reset = await songPage.evaluate(() => {
        const el = document.querySelector('audio, video')
        window.__recState.chunks = []
        window.__recState.frames = 0
        window.__recState.recording = true
        el.currentTime = 0
        el.playbackRate = 4
        el.preservesPitch = false
        el.play().catch(() => {})
        return { dur: el.duration, paused: el.paused }
      })
      console.log('reset', JSON.stringify(reset))

      let ok = false
      const deadline = Date.now() + ((song.dur || 30) * 1000) + 60000
      let stallFrom = null
      let lastFrames = -1
      let lastTime = null
      let rateObserved = 1
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500))
        const st = await songPage.evaluate(() => ({ frames: window.__recState.frames, rec: window.__recState.recording, time: document.querySelector('audio, video')?.currentTime, paused: document.querySelector('audio, video')?.paused, sr: window.__recState.sr, rate: document.querySelector('audio, video')?.playbackRate })).catch(() => null)
        if (!st?.rec) { console.log('rec shattered (nav)'); break }
        if (st.sr) {
          const needed = Math.ceil(((song.dur || 30) + 2.5) * st.sr)
          if (st.frames >= needed) { ok = true; rateObserved = st.rate ?? 1; break }
        }
        if (st.frames === lastFrames) {
          if (!stallFrom) stallFrom = Date.now()
          if (Date.now() - stallFrom > 45000) { console.log('stall break'); break }
        } else {
          stallFrom = null
          lastFrames = st.frames
          if (lastTime && st.time) rateObserved = (st.time - lastTime)
        }
        // keep 4x enforced; the site resets playbackRate to 1 at internal events
        await songPage.evaluate(() => { const el = document.querySelector('audio, video'); if (el.playbackRate !== 4) { el.playbackRate = 4; el.preservesPitch = false } })
        lastTime = st.time
      }
      console.log('captured', ok ? 'complete' : 'partial')
      // stop collecting before nav talks
      await songPage.evaluate(() => { window.__recState.recording = false; try { const el = document.querySelector('audio, video'); el.pause() } catch {} })
      if (!ok) throw new Error('record failed (frames incomplete)')
      // bake + pull
      const build = await songPage.evaluate(() => {
        const st = window.__recState
        const sr = st.sr
        const frames = st.chunks.reduce((a, c) => a + c.chans[0].length, 0)
        const dataLen = frames * 2 * 2
        const out = new Uint8Array(44 + dataLen)
        const dv = new DataView(out.buffer)
        const W = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
        W(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); W(8, 'WAVE'); W(12, 'fmt ')
        dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true)
        dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true)
        W(36, 'data'); dv.setUint32(40, dataLen, true)
        let o = 44
        for (const c of st.chunks) {
          const ch0 = c.chans[0], ch1 = c.chans[1] ?? c.chans[0]
          for (let k = 0; k < ch0.length && o + 4 <= out.length; k++) {
            let v = Math.max(-1, Math.min(1, ch0[k]))
            const e0 = v < 0 ? v * 32768 : v * 32767
            out[o] = e0 & 0xff; out[o + 1] = (e0 >> 8) & 0xff
            let w = Math.max(-1, Math.min(1, ch1[k]))
            const e1 = w < 0 ? w * 32768 : w * 32767
            out[o + 2] = e1 & 0xff; out[o + 3] = (e1 >> 8) & 0xff
            o += 4
          }
        }
        window.__recState.wavBytes = out
        return out.length
      })

      const CHUNK = 1024 * 1024
      const buf = Buffer.alloc(build)
      let pos = 0
      while (pos < build) {
        const b64 = await songPage.evaluate((arg) => {
          const { o, n } = arg
          const bytes = window.__recState.wavBytes.subarray(o, o + n)
          let s = ''
          for (let i2 = 0; i2 < bytes.length; i2 += 32768) {
            s += String.fromCharCode.apply(null, bytes.subarray(i2, i2 + 32768 < bytes.length ? i2 + 32768 : bytes.length))
          }
          return btoa(s)
        }, { o: pos, n: CHUNK })
        const piece = Buffer.from(b64, 'base64')
        piece.copy(buf, pos)
        pos += piece.length
      }
      fs.writeFileSync(outFileWav, buf)
      console.log('saved', outFileWav, buf.length, 'bytes')
    } catch (e) {
      console.log('✗', safe, String(e).slice(0, 160))
    } finally {
      await songPage.close().catch(() => {})
    }
  }
  console.log('batch done')
}

main().catch((e) => { console.error('BATCH FAILED', String(e).slice(0, 500)); process.exitCode = 1 })
