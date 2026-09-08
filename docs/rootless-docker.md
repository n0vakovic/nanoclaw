# Private rootless Docker

NanoClaw can use a Docker daemon owned by the login user. This avoids adding the user to the privileged Docker group or changing system Docker socket permissions. Docker runs in a user namespace; container UID 0 maps to the login user's host UID.

The reproducible setup is `scripts/setup-rootless-docker.sh`. It requires existing Docker 29.7.2, x86_64 Linux, user systemd, `newuidmap`/`newgidmap`, and an existing subordinate UID/GID allocation. It downloads a pinned official Docker rootless extras bundle, installs only user-local helpers and a user unit, then enables that unit. The checksum pins the bundle downloaded over Docker's HTTPS endpoint; it is not a separately signed vendor attestation. The script does not install system packages, change group membership, adjust ACLs, enable lingering, or modify sysctls.

The installed service is `nanoclaw-docker.service`. Its isolated storage is `~/.local/share/nanoclaw/docker`, helpers are in `~/.local/share/nanoclaw/rootless/bin`, and the socket is `/run/user/<uid>/nanoclaw-docker.sock`. System Docker's images are not shared; build the NanoClaw image with `DOCKER_HOST` set to this socket.

For milan (UID 1000), the host process requires:

```sh
DOCKER_HOST=unix:///run/user/1000/nanoclaw-docker.sock
NANOCLAW_ROOTLESS=1
CREDENTIAL_PROXY_HOST=127.0.0.1
```

The application must detect/configure rootless execution and pass container options `--user 0:0`, `-e HOME=/home/node`, and `-e IS_SANDBOX=1`. The latter is required by the installed Claude SDK when using permission bypass as namespace UID 0. It does not give the container host root privileges. Mount ownership remains UID 1000 on the host.

The service uses RootlessKit's `gvisor-tap-vsock` networking, enables host loopback access, and sets Docker's host gateway to `10.0.2.1`. Thus `--add-host host.docker.internal:host-gateway` reaches the credential proxy while it binds only to host `127.0.0.1`. Enabling host loopback access also permits containers to reach other host loopback services; it is not a proxy-specific network restriction. The Docker API socket is never mounted into agent containers.

Verify with:

```sh
systemctl --user status nanoclaw-docker.service
DOCKER_HOST=unix:///run/user/1000/nanoclaw-docker.sock docker info
```

The security options must include `rootless`. On this machine the daemon uses the systemd cgroup driver with CPU, memory and PID controls; cpuset and I/O controllers are not delegated. User lingering is disabled, so enabling this unit starts it at user login, not unattended boot before login. No privileged persistence change is made.

Validated on September 8, 2026: Docker 29.7.2/rootlesskit 3.0.2 started under milan; an Alpine container reached a temporary host loopback-only HTTP server via `host.docker.internal`, and a file written through a bind mount by container UID 0 was owned by host UID 1000. The built NanoClaw image also loaded SDK CLI 2.1.76 and imported its SDK successfully. A single tool-free SDK request through the existing OAuth credential proxy returned exactly `NANOCLAW_READY` with success/exit 0; its temporary container and workspace were removed.

Sources: [Docker rootless installation](https://docs.docker.com/engine/security/rootless/), [daemon and cgroup guidance](https://docs.docker.com/engine/security/rootless/tips/), and [RootlessKit 3.0.2 gvisor host-loopback mapping](https://github.com/rootless-containers/rootlesskit/blob/v3.0.2/pkg/network/gvisortapvsock/gvisortapvsock.go).
