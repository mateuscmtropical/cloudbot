// A test can leave a queued turn that starts in the background, such as after a stop, and makes folders under the
// data folder while the test removes it. With these retries rm waits for that work and tries again on ENOTEMPTY,
// instead of failing a test that passed.
const CLEANUP_RETRIES = 5;

export { CLEANUP_RETRIES };
