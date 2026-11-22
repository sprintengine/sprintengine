import { createGrammarTokenizer, type GrammarRequest } from './grammarTokenizer'

// The grammar worker's entry: it says `ready` once its engine can serve, then
// takes one request at a time from grammarHost.ts, which terminates this
// worker when a request outlives its budget.

const tokenizer = createGrammarTokenizer()
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<GrammarRequest>) => void) | null
  postMessage(message: unknown): void
}
scope.onmessage = (event) => {
  void tokenizer.handle(event.data).then((response) => scope.postMessage(response))
}
void tokenizer.ready.then(() => scope.postMessage({ type: 'ready' }))
