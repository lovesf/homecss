"""管理会话与登录限流。会话只存在内存中，服务重启后需要重新输入管理密码。"""

from __future__ import annotations

import secrets
import time

SESSION_IDLE_SECONDS = 10 * 60
FREE_ATTEMPTS = 5
BASE_LOCK_SECONDS = 60
MAX_LOCK_SECONDS = 15 * 60


class Sessions:
    def __init__(self) -> None:
        self._sessions: dict[str, float] = {}

    def create(self) -> str:
        session_id = secrets.token_urlsafe(32)
        self._sessions[session_id] = time.monotonic() + SESSION_IDLE_SECONDS
        return session_id

    def touch(self, session_id: str | None) -> bool:
        """有效则顺延空闲期限。"""
        if not session_id:
            return False
        expires = self._sessions.get(session_id)
        now = time.monotonic()
        if expires is None or expires < now:
            self._sessions.pop(session_id, None)
            return False
        self._sessions[session_id] = now + SESSION_IDLE_SECONDS
        return True

    def revoke(self, session_id: str | None) -> None:
        if session_id:
            self._sessions.pop(session_id, None)

    def revoke_all(self) -> None:
        self._sessions.clear()


class LoginLimiter:
    """4 位密码只有一万种组合：连续输错 5 次后锁定，锁定时间逐次翻倍，最长 15 分钟。"""

    def __init__(self) -> None:
        self.failures = 0
        self.locked_until = 0.0

    def retry_after(self) -> int:
        return max(0, int(self.locked_until - time.monotonic() + 0.999))

    def record_failure(self) -> int:
        """返回锁定秒数；未锁定时为 0。"""
        self.failures += 1
        if self.failures < FREE_ATTEMPTS:
            return 0
        seconds = min(MAX_LOCK_SECONDS, BASE_LOCK_SECONDS * 2 ** (self.failures - FREE_ATTEMPTS))
        self.locked_until = time.monotonic() + seconds
        return seconds

    def remaining_attempts(self) -> int:
        return max(0, FREE_ATTEMPTS - self.failures)

    def record_success(self) -> None:
        self.failures = 0
        self.locked_until = 0.0
