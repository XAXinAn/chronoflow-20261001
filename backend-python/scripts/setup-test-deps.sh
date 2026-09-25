#!/usr/bin/env bash
# 把测试用的 PostgreSQL 与 Redis 二进制准备到 ~/.cache/xa-todo。
#
# 本机既没有 root（装不了 postgresql/redis-server），Python 侧也没有嵌入式发行版，
# 但 Maven 本地仓库里已经有这两个 jar —— Java 测试正是用它们跑起来的。
# 直接复用同一份二进制，两版测试跑在完全相同的 PG 16.15 / Redis 6.2 上。
set -euo pipefail

M2="${HOME}/.m2/repository"
TARGET="${HOME}/.cache/xa-todo"
mkdir -p "${TARGET}/pg" "${TARGET}/redis"

PG_JAR=$(find "${M2}/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64" -name '*.jar' | head -1)
REDIS_JAR=$(find "${M2}/com/github/codemonstur/embedded-redis" -name '*.jar' | head -1)

if [ -z "${PG_JAR}" ] || [ -z "${REDIS_JAR}" ]; then
  echo "未找到嵌入式二进制 jar，请先在 backend-java 下执行 mvn -q dependency:resolve" >&2
  exit 1
fi

python3 - "$PG_JAR" "$REDIS_JAR" "$TARGET" <<'PY'
import io, os, stat, sys, tarfile, zipfile

pg_jar, redis_jar, target = sys.argv[1], sys.argv[2], sys.argv[3]

with zipfile.ZipFile(pg_jar) as z:
    data = z.read('postgres-linux-x86_64.txz')
with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as t:
    t.extractall(os.path.join(target, 'pg'))

with zipfile.ZipFile(redis_jar) as z:
    name = next(n for n in z.namelist() if n == 'redis-server-6.2.6-v5-linux-amd64')
    binary = z.read(name)
redis_path = os.path.join(target, 'redis', 'redis-server')
with open(redis_path, 'wb') as f:
    f.write(binary)
os.chmod(redis_path, os.stat(redis_path).st_mode | stat.S_IXUSR)

print('PostgreSQL →', os.path.join(target, 'pg', 'bin', 'postgres'))
print('Redis      →', redis_path)
PY

"${TARGET}/pg/bin/postgres" --version
"${TARGET}/redis/redis-server" --version
