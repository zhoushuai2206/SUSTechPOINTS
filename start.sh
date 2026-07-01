#!/usr/bin/env bash
# =============================================================================
# SUSTechPOINTS 启动脚本
# -----------------------------------------------------------------------------
# 若被 `sh start.sh` 调起，此时可能是 dash 之类的 POSIX shell，
# 不支持 ${BASH_SOURCE[0]} / source 等 bash 语法，自动用 bash 重新执行。
if [ -z "${BASH_VERSION:-}" ]; then
    if command -v bash >/dev/null 2>&1; then
        exec bash "$0" "$@"
    else
        echo "[FAIL] 需要 bash 运行本脚本，请先安装 bash" >&2
        exit 1
    fi
fi
#
# 功能：
#   1. 激活 setup_env.sh 创建的虚拟环境 tf_env/
#   2. 确保 temp/ 目录存在（server.conf 依赖）
#   3. 启动 CherryPy 服务（main.py）
#
# 用法：
#   bash start.sh              # 前台启动，Ctrl+C 停止
#   bash start.sh -d           # 后台启动，日志写入 server.log
#   bash start.sh --stop       # 停止后台进程
#   bash start.sh --status     # 查看后台进程状态
#   bash start.sh --help
# =============================================================================

set -e

# ---------- 颜色 ----------
if [ -t 1 ]; then
    C_RED="\033[31m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"
    C_BLUE="\033[34m"; C_BOLD="\033[1m"; C_RESET="\033[0m"
else
    C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_RESET=""
fi

log_info()  { echo -e "${C_BLUE}[INFO]${C_RESET}  $*"; }
log_ok()    { echo -e "${C_GREEN}[ OK ]${C_RESET}  $*"; }
log_warn()  { echo -e "${C_YELLOW}[WARN]${C_RESET}  $*"; }
log_error() { echo -e "${C_RED}[FAIL]${C_RESET}  $*" >&2; }

print_help() {
    cat <<'EOF'
SUSTechPOINTS 启动脚本

用法：
    bash start.sh              前台启动，Ctrl+C 停止
    bash start.sh -d           后台启动，日志写入 server.log
    bash start.sh --stop       停止后台进程
    bash start.sh --status     查看后台进程状态
    bash start.sh --help       查看帮助

依赖：先执行 bash setup_env.sh 创建虚拟环境 tf_env/
EOF
}

# ---------- 切到脚本目录 ----------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR="tf_env"
ENTRY="main.py"
CONF="server.conf"
LOG_FILE="server.log"
PID_FILE=".server.pid"
HOST="127.0.0.1"
PORT="8081"

# ---------- 从 server.conf 提取端口（可选，失败则用默认） ----------
if [ -f "$CONF" ]; then
    _port=$(grep -E '^\s*server\.socket_port' "$CONF" | head -n1 | awk -F'=' '{print $2}' | tr -d ' "')
    [ -n "$_port" ] && PORT="$_port"
fi

# ---------- 参数解析 ----------
ACTION="run"
DAEMON=0
for arg in "$@"; do
    case "$arg" in
        -d|--daemon)     DAEMON=1 ;;
        --stop)          ACTION="stop" ;;
        --status)        ACTION="status" ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *) log_warn "未知参数: $arg" ;;
    esac
done

# ---------- 停止 ----------
if [ "$ACTION" = "stop" ]; then
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            log_info "停止后台进程 PID=$PID ..."
            kill "$PID"
            sleep 1
            kill -0 "$PID" 2>/dev/null && { log_warn "进程仍在，强制 kill -9"; kill -9 "$PID"; }
            log_ok "已停止"
        else
            log_warn "PID=$PID 已不存在"
        fi
        rm -f "$PID_FILE"
    else
        log_warn "未发现 $PID_FILE，可能未通过本脚本后台启动"
    fi
    exit 0
fi

# ---------- 状态 ----------
if [ "$ACTION" = "status" ]; then
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        log_ok "服务运行中，PID=$(cat "$PID_FILE")，地址: http://${HOST}:${PORT}"
    else
        log_warn "服务未在后台运行"
    fi
    exit 0
fi

# ---------- 检查虚拟环境 ----------
if [ ! -d "$VENV_DIR" ]; then
    log_error "虚拟环境 $VENV_DIR/ 不存在，请先执行： bash setup_env.sh"
    exit 1
fi

if [ ! -f "$VENV_DIR/bin/activate" ]; then
    log_error "$VENV_DIR/bin/activate 缺失，虚拟环境可能已损坏，请重建： bash setup_env.sh --force"
    exit 1
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
log_ok "已激活虚拟环境: $(python -c 'import sys; print(sys.executable)')"

# ---------- 检查入口文件 ----------
if [ ! -f "$ENTRY" ]; then
    log_error "找不到入口文件 $ENTRY"
    exit 1
fi

# ---------- 必要目录 ----------
mkdir -p temp data

# ---------- 端口占用检查 ----------
if command -v lsof &>/dev/null; then
    if lsof -iTCP:"$PORT" -sTCP:LISTEN &>/dev/null; then
        log_warn "端口 $PORT 已被占用，如是本脚本后台进程可先执行： bash start.sh --stop"
    fi
fi

# ---------- 检查已有后台进程 ----------
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log_error "检测到已在运行的后台进程 PID=$(cat "$PID_FILE")，请先执行： bash start.sh --stop"
    exit 1
fi

# ---------- 启动 ----------
log_info "启动服务 ..."
log_info "访问地址： ${C_BOLD}http://${HOST}:${PORT}${C_RESET}"

if [ "$DAEMON" = "1" ]; then
    nohup python "$ENTRY" >"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1
    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        log_ok "后台已启动，PID=$(cat "$PID_FILE")，日志： $LOG_FILE"
    else
        log_error "后台启动失败，请查看 $LOG_FILE"
        rm -f "$PID_FILE"
        exit 1
    fi
else
    exec python "$ENTRY"
fi
