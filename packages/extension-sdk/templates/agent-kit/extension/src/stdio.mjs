// The program an agent starts (`node ${extensionPath}/src/stdio.mjs` in
// extension.json): the server's loop on stdin and stdout. Kept apart from
// server.mjs so a test can import the server without it waiting on stdin.

import { serve } from './server.mjs'

serve()
