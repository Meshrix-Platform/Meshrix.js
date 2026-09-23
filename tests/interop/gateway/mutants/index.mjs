import * as dropBusinessField from './drop-business-field.mjs';
import * as dropUnprefixedMeta from './drop-unprefixed-meta.mjs';
import * as completeCoercion from './complete-coercion.mjs';
import * as contextMixing from './context-mixing.mjs';
import * as replayEffect from './replay-effect.mjs';
import * as routeChange from './route-change.mjs';
import * as authBypass from './auth-bypass.mjs';
import * as wrongUriRewrite from './wrong-uri-rewrite.mjs';
import { COUNTEREXAMPLES } from './new-counterexamples.mjs';

export const MUTANTS = Object.freeze([
  dropBusinessField,
  dropUnprefixedMeta,
  completeCoercion,
  contextMixing,
  replayEffect,
  routeChange,
  authBypass,
  wrongUriRewrite,
  ...COUNTEREXAMPLES
]);
