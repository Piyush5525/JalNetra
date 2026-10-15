// Child process: text on argv, mp3 bytes on stdout. Kept separate from the API server process.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
const [voice, b64] = process.argv.slice(2)
const text = Buffer.from(b64, 'base64').toString('utf8')   // base64 keeps Hindi intact through the Windows command line
const t = new MsEdgeTTS()
await t.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
const { audioStream } = t.toStream(text)
const chunks = []
await new Promise((resolve, reject) => { audioStream.on('data', c => chunks.push(c)); audioStream.on('end', resolve); audioStream.on('close', resolve); audioStream.on('error', reject) })
t.close()
const out = Buffer.concat(chunks)
if (!out.length) { console.error('empty audio'); process.exit(2) }
process.stdout.write(out, () => process.exit(0))
