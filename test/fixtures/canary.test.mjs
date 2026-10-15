// Canary: `npm test` must never run files under test/fixtures. Node's default
// discovery would pick this file up, so executing it fails the run loudly.

throw new Error('test/fixtures was executed as a test; fix the npm test glob')
