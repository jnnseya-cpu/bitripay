#!/usr/bin/env bash
# Pull-based automatic deployment for the production host (no GitHub secrets needed).
# Run by the systemd timer installed with deploy/install-auto-deploy.sh (every 5 minutes) or by hand:
#   bash deploy/auto-deploy.sh            deploy when the tracked branch moved on GitHub and CI is green for it
#   bash deploy/auto-deploy.sh --force    deploy the current remote head now, whatever the CI state
# Reads deploy/.env.production for:
#   AUTO_DEPLOY_BRANCH   branch to follow (default: the branch currently checked out)
#   DEPLOY_MODE          shared-host (default) or dedicated, passed to scripts/deploy.sh
#   GITHUB_TOKEN         optional; needed to read the CI status of a private repository (a fine-grained token with
#                        "Actions: read" on this repository). Without it on a private repo the CI gate cannot be read
#                        and nothing is deployed automatically.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=deploy/.env.production
LOCK=/tmp/bitripay-auto-deploy.lock
STATE=deploy/.auto-deploy.last
exec 9>"$LOCK"; flock -n 9 || { echo "another deployment is running"; exit 0; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }
val() { grep -E "^$1=.+" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
BRANCH="$(val AUTO_DEPLOY_BRANCH)"
if [ -z "$BRANCH" ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  # A detached checkout (an earlier deployment, a tag) follows the remote's default branch.
  if [ "$BRANCH" = HEAD ]; then BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')"; fi
  if [ -z "$BRANCH" ]; then BRANCH="$(git remote show origin 2>/dev/null | sed -n 's/^ *HEAD branch: //p')"; fi
fi
[ -n "$BRANCH" ] || { echo "Cannot tell which branch to follow: set AUTO_DEPLOY_BRANCH in $ENV_FILE"; exit 1; }
export DEPLOY_MODE="$(val DEPLOY_MODE)"; [ -n "$DEPLOY_MODE" ] || export DEPLOY_MODE=shared-host
TOKEN="$(val GITHUB_TOKEN)"
REPO="$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
FORCE=0; [ "${1:-}" = "--force" ] && FORCE=1

git fetch --quiet origin "$BRANCH"
REMOTE="$(git rev-parse "origin/$BRANCH")"
CURRENT="$(git rev-parse HEAD)"
LAST="$(cat "$STATE" 2>/dev/null || true)"
if [ "$FORCE" = 0 ] && [ "$REMOTE" = "$CURRENT" ] && [ "$LAST" = "$REMOTE" ]; then exit 0; fi   # nothing new
if [ "$FORCE" = 0 ] && [ "$REMOTE" = "$LAST" ]; then exit 0; fi                                   # already deployed (or refused) this commit

if [ "$FORCE" = 0 ]; then
  # CI gate: the "verify" workflow must have completed successfully for this exact commit.
  AUTH=(); [ -n "$TOKEN" ] && AUTH=(-H "Authorization: Bearer $TOKEN")
  RUNS="$(curl -sS --max-time 20 "${AUTH[@]}" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$REMOTE&per_page=5" || true)"
  CONCLUSION="$(printf '%s' "$RUNS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const r=(j.workflow_runs||[])[0];console.log(r?`${r.status}:${r.conclusion}`:"none")}catch{console.log("unreadable")}})')"
  case "$CONCLUSION" in
    completed:success) echo "CI green for ${REMOTE:0:7} on $BRANCH" ;;
    none) echo "No CI run yet for ${REMOTE:0:7}; waiting"; exit 0 ;;
    unreadable) echo "Cannot read CI status for $REPO (private repository without GITHUB_TOKEN?); not deploying"; exit 0 ;;
    completed:*) echo "CI is $CONCLUSION for ${REMOTE:0:7}; not deploying"; echo "$REMOTE" > "$STATE"; exit 0 ;;
    *) echo "CI still running ($CONCLUSION) for ${REMOTE:0:7}; waiting"; exit 0 ;;
  esac
fi

echo "$(date -Is) deploying ${REMOTE:0:7} ($BRANCH) in $DEPLOY_MODE mode"
# Stay on the branch (never a detached commit) so `git pull` and `npm run …` on the host keep working.
git checkout --quiet --force -B "$BRANCH" "$REMOTE"
git branch --quiet --set-upstream-to "origin/$BRANCH" "$BRANCH" 2>/dev/null || true
npm run deploy
echo "$REMOTE" > "$STATE"
echo "$(date -Is) deployed ${REMOTE:0:7}"
