import { ZxcvbnFactory } from '@zxcvbn-ts/core'
import { adjacencyGraphs, dictionary as commonDictionary } from '@zxcvbn-ts/language-common'
import { dictionary as englishDictionary, translations } from '@zxcvbn-ts/language-en'

const estimator = new ZxcvbnFactory({
  translations,
  graphs: adjacencyGraphs,
  dictionary: { ...commonDictionary, ...englishDictionary },
})

export function passwordStrength(password: string, username: string, workspace: string) {
  const result = estimator.check(password.slice(0, 128), [username, workspace])
  return { score: result.score, warning: result.feedback.warning, suggestions: result.feedback.suggestions }
}
