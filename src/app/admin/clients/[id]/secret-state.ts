/** What the "generate a signing secret" action returns to the page that asked: the new secret (shown once) or an error code. */
export interface SecretState {
  secret?: string;
  error?: string;
}
