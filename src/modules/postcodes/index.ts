/** Public surface of the postcodes module: normalisation (shared with the browser) and the lookup service. */
export { normalisePostcode } from "./normalise";
export { createPostcodeService, type PostcodeCheck, type PostcodeService } from "./service";
