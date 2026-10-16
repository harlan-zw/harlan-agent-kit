# Hogwild emergency isolation from a phone

At `https://agent.harlanzw.com`, sign in with a Passkey, open **System**, choose
**Isolate Hogwild**, then **Confirm with Passkey**. The second Passkey prompt
authorizes this action. Cancelling before the request leaves the server running.

Isolation stops workloads, blocks their network access, and disconnects this site.
Power stays on. Acknowledgment means the isolation job was queued, not that every
workload has stopped. A lost response leaves the result uncertain: inspect using
`ssh hogwild-recovery` rather than sending another request.

Restore networking from an admin laptop using **Hogwild Restore Network** or:

```sh
ssh hogwild-recovery 'sudo /usr/bin/node /opt/hogwild-emergency/emergency.mjs recover --confirm=RESTORE-HOGWILD-NETWORK'
```

Inspect the host before restarting workloads. This website cannot restore itself
after isolation. Keep Tailscale and the separate recovery SSH credential available.
Never test real isolation on a host without a viable recovery connection.

## Trust boundary

The dashboard requires a public Passkey session and its normal same-origin POST
check. Basic credentials and private/password browser sessions cannot invoke this
control. The Agent forwards only status, challenge, and isolation requests over a
fixed Unix socket. It receives no sudo, restore, power, or arbitrary-command access.

A separate root-owned broker uses SimpleWebAuthn to verify a fresh, signed assertion
for the exact public origin and RP ID, requiring user verification. Challenges
expire after two minutes, are single use, and are bound to an administrator-approved
credential. The broker persists counters before invoking the existing root-owned
isolation controller. The socket has no network listener and admits only root and
the `harlan` group. Root code and verification keys are not writable by the Agent.

Compromise of root can disable this control. The public tunnel and dashboard must
still be reachable to request isolation. Passkey confirmation proves a credential
holder approved a browser request; it cannot make a compromised browser UI trusted.
This is workload containment with admin recovery, not a physical network cut.

## Administrator installation

First install the recoverable controller from `harlan-zw/hogwild-gh-runner`,
including recovery SSH and boot lock. Validate its `check` action. Build this broker
in a trusted checkout with the exact workspace lockfile:

```sh
node packages/harlan-github-agent/security/build.ts /trusted/output
```

Provision only public Passkey material, exported from the service's existing
public browser authority with Node 24 as `harlan`:

```sh
node packages/harlan-github-agent/security/export-passkeys.ts ~/.local/share/harlan-github-agent/browser-auth > /private/staging/public-passkeys.json
```

An administrator must approve this initial credential snapshot. Do not automatically
resync keys from an Agent-writable database. On a suspected compromise, obtain
approved verification keys from trusted records rather than exporting that database.
Copy reviewed artifacts to the server, then install as root:

```sh
install -d -o root -g root -m 700 /etc/hogwild-emergency /var/lib/hogwild-emergency
install -o root -g root -m 600 /private/staging/public-passkeys.json /etc/hogwild-emergency/public-passkeys.json
install -o root -g root -m 644 /trusted/output/emergency-broker.mjs /opt/hogwild-emergency/emergency-broker.mjs
install -o root -g root -m 644 /trusted/output/hogwild-emergency-broker.{service,socket} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hogwild-emergency-broker.socket
```

Deploy the dashboard commit through the normal durable Service update. After
adding or revoking a Passkey, an administrator must explicitly replace the approved
root snapshot and restart only `hogwild-emergency-broker.service`. Preserve
`/var/lib/hogwild-emergency/passkey-counters.json`; do not roll counters backward.
Changing keys in the dashboard does not change the root snapshot automatically.

## Safe verification

```sh
curl --fail --unix-socket /run/hogwild-emergency-broker.sock http://localhost/status
```

Status validates controller readiness without requesting isolation. Automated tests
exercise real signed synthetic assertions and mock the final isolation operation.
Browser checks use a local fixture with a fake action endpoint, never production
activation. An actual end-to-end outage and post-isolation recovery remain untested.
