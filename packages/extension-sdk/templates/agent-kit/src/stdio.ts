// The program an agent starts (extension/dist/server.mjs): the server's loop
// on stdin and stdout. Kept apart from server.ts so a test can import the
// server without it waiting on stdin.

import { serve } from './server'

serve()
