import { createGrammarTokenizer, type GrammarRequest } from './grammarTokenizer'

// The grammar worker's entry: one request at a time, from grammarHost.ts,
// which terminates this worker when a request outlives its deadline.

const tokenizer = createGrammarTokenizer()
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<GrammarRequest>) => void) | null
  postMessage(message: unknown): void
}
scope.onmessage = (event) => {
  void tokenizer.handle(event.data).then((response) => scope.postMessage(response))
}
