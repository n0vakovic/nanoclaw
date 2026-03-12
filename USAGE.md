# NanoClaw Usage

## Scripts

```bash
./scripts/stop.sh       # Stop the service
./scripts/restart.sh    # Rebuild and restart
./scripts/logs.sh       # Tail live logs
```

## Service Management

```bash
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
systemctl --user status nanoclaw
```

## Customize the Bot

Edit `groups/telegram_main/CLAUDE.md` to change personality, instructions, and memory.
Changes take effect on the next message (no restart needed).

## Browse the Agent's Filesystem

The agent works inside `groups/telegram_main/`. To see what it's written:

```bash
ls groups/telegram_main/
cat groups/telegram_main/CLAUDE.md
```

Session logs are in `groups/telegram_main/logs/`.

## Logs

```bash
tail -f logs/nanoclaw.log                    # Main service log
ls groups/telegram_main/logs/container-*.log  # Agent container logs
```
