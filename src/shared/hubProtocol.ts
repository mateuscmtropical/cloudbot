// How the hub and an instance talk. Both sides use only these names.

// The hub adds this header to every request it forwards to an instance. Its value is the secret of that instance.
// The instance treats a request with the right value as signed in, and the hub removes the header from browsers.
const HUB_TRUST_HEADER = 'x-cloudbot-hub';

// The owner's instance sends these two headers to the hub admin API. The secret is the one the hub gave that instance.
const INSTANCE_NAME_HEADER = 'x-cloudbot-instance';
const INSTANCE_SECRET_HEADER = 'x-cloudbot-secret';

// The hub admin API, served only on the internal network. Paths are relative to CLOUDBOT_HUB_URL.
//   GET    /internal/people                        the people, as Person[]
//   POST   /internal/people                        body AddPersonRequest, answers 201 with PersonWithPassword
//   POST   /internal/people/:name/deactivate       answers Person
//   POST   /internal/people/:name/reactivate       answers Person
//   POST   /internal/people/:name/reset-password   answers ResetPasswordResult
//   DELETE /internal/people/:name?confirm=:name    answers 204. The owner cannot be deleted.
// Only the owner's instance may call it. Every error is { error: string } with a 4xx status.
const HUB_PEOPLE_PATH = '/internal/people';

// What an instance reports to the hub when asked. The hub calls it before it stops the instance.
//   GET /api/hub/activity   answers InstanceActivity
const HUB_ACTIVITY_PATH = '/api/hub/activity';

interface InstanceActivity {
    isBusy: boolean;
    // Short reasons, for logs and for the owner. For example "turn running" or "routine enabled".
    reasons: string[];
}

export { HUB_ACTIVITY_PATH, HUB_PEOPLE_PATH, HUB_TRUST_HEADER, INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER };
export type { InstanceActivity };
