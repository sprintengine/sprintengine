// The app's words. `en.ts` holds them; a second language is another file of
// type `Copy`, chosen here.

import { en, type Copy } from './en'

export type { Copy }

export const copy: Copy = en
