# -*- coding: utf-8 -*-
"""
lib/sandbox/sitecustomize.py —— 运行 LLM 生成代码时的 Python 侧沙箱守卫。

【重要：这是"缓解"，不是可靠隔离】
CPython 启动时会自动 import 名为 sitecustomize 的模块（除非加了 -S），
lib/sandbox.js 通过把本目录塞进 PYTHONPATH 来让本模块自动生效。
本模块做的事只有一件：把用户代码最常用的几个"出口函数"换成带路径/网络检查的版本。
它挡不住下面这些：
  * 显式调用 os.posix_spawn / ctypes / _winapi / mmap 等绕过 Python 层的通道；
  * 直接写 sys.modules 把被 patch 的函数换回去；
  * 用 __import__ 加载别的模块再取原始实现；
  * 任何真正的原生代码（C/C++ 通道）——那需要 job object / 容器 / 低权限账户。
真正的隔离要在操作系统层面做（受限账户 + ACL + 防火墙规则）。这里只求挡住
"题面里藏了提示注入，诱导模型生成一段偷读 ~/.ssh 或对外发请求的代码" 这一档。

环境变量（由 lib/sandbox.js 设置）：
  SANDBOX_DIR       允许自由读写的目录（题目程序的工作目录），空 = 不限制文件访问
  SANDBOX_ALLOW_NET '0' = 禁止网络（默认），'1' = 不干预
本模块所有 patch 都用 try/except 包住：patch 失败就静默跳过，
绝不因为守卫自己出错而让用户的题目程序崩溃。
"""

import builtins
import io
import os
import sys

# ---------------------------------------------------------------- 配置读取

try:
    _SANDBOX_DIR_RAW = os.environ.get('SANDBOX_DIR') or ''
except Exception:  # pragma: no cover - 环境变量读取不该失败
    _SANDBOX_DIR_RAW = ''

try:
    _ALLOW_NET = (os.environ.get('SANDBOX_ALLOW_NET') == '1')
except Exception:  # pragma: no cover
    _ALLOW_NET = True

# 守卫自身读文件时要用的原始函数（必须在 patch 之前取出来，否则会递归）
_ORIG_OPEN = builtins.open
_ORIG_OS_OPEN = os.open
_ORIG_REALPATH = os.path.realpath
_ORIG_NORM_CASE = os.path.normcase
_ORIG_NORM_PATH = os.path.normpath
_ORIG_GETCWD = os.getcwd
_ORIG_STR = str


# ---------------------------------------------------------------- 路径判定

def _norm_root(p):
    """把沙箱根目录规范化成"可比较、无尾分隔符"的形式"""
    p = _ORIG_NORM_PATH(_ORIG_STR(p))
    sep = os.sep
    while len(p) > 3 and p.endswith(sep):
        p = p[:-1]
    return _ORIG_NORM_CASE(p)


try:
    _ROOT = _norm_root(_SANDBOX_DIR_RAW) if _SANDBOX_DIR_RAW else ''
except Exception:  # pragma: no cover
    _ROOT = ''


def _realpath_safe(p):
    """尽量解析成绝对真实路径。

    注意：os.path.realpath 对"不存在的路径"在 Windows 上不会自作主张补全，
    所以这里先试 realpath；失败（例如权限/巨长路径）再退化成 abspath。
    对越权判断来说，宁可判成"越权"也不要漏放。
    """
    try:
        return _ORIG_REALPATH(p)
    except Exception:
        try:
            return os.path.abspath(p)
        except Exception:
            return _ORIG_STR(p)


def _inside_sandbox(p):
    """目标路径是否落在沙箱目录内（大小写不敏感；已解析 .. 穿越与符号链接）"""
    if not _ROOT:
        return True  # 没配置沙箱目录 = 不限制文件访问
    try:
        rp = _ORIG_NORM_CASE(_ORIG_NORM_PATH(_realpath_safe(p)))
    except Exception:
        return False
    if rp == _ROOT:
        return True
    return rp.startswith(_ROOT + os.sep)


def _deny(path):
    raise PermissionError('沙箱：拒绝访问沙箱目录之外的路径 ' + _ORIG_STR(path))


def _check(path):
    """检查一个路径参数；非路径类型（None / int 文件描述符）直接放行。

    已打开的文件描述符（包括运行器绑给 stdin/stdout/stderr 的那几个）
    一律放行：那是父进程给的句柄，不是用户代码新开的越权通道。
    """
    if path is None:
        return True
    try:
        p = os.fspath(path)          # 接受 str / bytes / os.PathLike
    except TypeError:
        return True                  # 整数 fd 之类，交给原函数处理
    if isinstance(p, bytes):
        try:
            p = p.decode('utf-8', 'surrogateescape')
        except Exception:
            return True
    if not isinstance(p, _ORIG_STR):
        return True
    if _inside_sandbox(p):
        return True
    _deny(p)
    return False


def _wrap(name, module, checker):
    """把 module.name 换成"先过 checker 再调原函数"的版本；失败静默跳过"""
    try:
        orig = getattr(module, name, None)
        if orig is None or getattr(orig, '__sandbox_wrapped__', False):
            return

        def wrapper(*args, **kwargs):
            checker(*args, **kwargs)
            return orig(*args, **kwargs)

        wrapper.__sandbox_wrapped__ = True
        wrapper.__sandbox_orig__ = orig
        try:
            wrapper.__name__ = getattr(orig, '__name__', name)
            wrapper.__doc__ = getattr(orig, '__doc__', None)
        except Exception:
            pass
        setattr(module, name, wrapper)
    except Exception:
        pass  # 守卫绝不能因为自己 patch 失败而影响用户程序


def _check_first():
    """只检查第一个位置参数（open / remove / mkdir / listdir ...）"""
    def checker(*args, **kwargs):
        if args:
            _check(args[0])
        elif 'path' in kwargs:
            _check(kwargs['path'])
        elif 'file' in kwargs:
            _check(kwargs['file'])
    return checker


def _check_first_two():
    """检查前两个位置参数（rename / replace / copy / move ...）"""
    def checker(*args, **kwargs):
        for p in args[:2]:
            _check(p)
        for key in ('src', 'dst'):
            if key in kwargs:
                _check(kwargs[key])
    return checker


# ---------------------------------------------------------------- 安装守卫

_INSTALLED = False

if _ROOT or not _ALLOW_NET:
    _INSTALLED = True

    # ---- 1) 网络 ----------------------------------------------------------
    if not _ALLOW_NET:
        def _net_disabled(name):
            def blocked(*_a, **_k):
                raise PermissionError('沙箱：已禁止网络访问（' + name + '）')
            return blocked

        try:
            import socket

            def _blocked_socket(*_a, **_k):
                raise PermissionError('沙箱：已禁止网络访问（socket.socket）')

            socket.socket = _blocked_socket
            socket.create_connection = _net_disabled('socket.create_connection')
            socket.create_server = _net_disabled('socket.create_server')
            socket.getaddrinfo = _net_disabled('socket.getaddrinfo')
            socket.gethostbyname = _net_disabled('socket.gethostbyname')
            try:
                socket.socketpair = _net_disabled('socket.socketpair')
            except Exception:
                pass
        except Exception:
            pass

        try:
            import urllib.request
            _ORIG_URLOPEN = urllib.request.urlopen

            def _blocked_urlopen(*_a, **_k):
                raise PermissionError('沙箱：已禁止网络访问（urllib.request.urlopen）')

            urllib.request.urlopen = _blocked_urlopen
            try:
                urllib.request.urlretrieve = _net_disabled('urllib.request.urlretrieve')
            except Exception:
                pass
        except Exception:
            pass

        # http.client 也顺手堵一下（requests 之类第三方库最终会落到它/socket）
        try:
            import http.client
            http.client.HTTPConnection.connect = _net_disabled('http.client.HTTPConnection.connect')
            http.client.HTTPSConnection.connect = _net_disabled('http.client.HTTPSConnection.connect')
        except Exception:
            pass

    # ---- 2) 文件系统：只拦"用户显式 open 任意路径"这条主通道 ------------------
    if _ROOT:
        # builtins.open / io.open：同时拦路径与 fd 两种入参形态
        try:
            def _open_guard(file, *args, **kwargs):
                _check(file)
                return _ORIG_OPEN(file, *args, **kwargs)

            _open_guard.__sandbox_wrapped__ = True
            _open_guard.__name__ = 'open'
            builtins.open = _open_guard
            io.open = _open_guard
        except Exception:
            pass

        # 说明：io.open 的 fd 形态（io.FileIO / os.fdopen）只接受整数 fd、无法回查路径，
        # 一律不拦 —— 运行器绑给子进程的 stdin/stdout/stderr 正是这种句柄。

        # os 模块各入口
        try:
            def _os_open_guard(path, *args, **kwargs):
                _check(path)
                return _ORIG_OS_OPEN(path, *args, **kwargs)

            _os_open_guard.__sandbox_wrapped__ = True
            _os_open_guard.__name__ = 'open'
            os.open = _os_open_guard
        except Exception:
            pass

        for _n in ('remove', 'unlink', 'rmdir', 'removedirs', 'mkdir', 'makedirs',
                   'chdir', 'listdir', 'scandir', 'stat', 'lstat', 'chmod',
                   'truncate', 'utime', 'readlink'):
            _wrap(_n, os, _check_first())

        for _n in ('rename', 'replace', 'link', 'symlink'):
            _wrap(_n, os, _check_first_two())

        # shutil 常用入口（它们内部多数也会走到上面 os.*，这里再包一层更明确）
        try:
            import shutil
            for _n in ('copy', 'copy2', 'copyfile', 'copymode', 'copystat', 'move', 'copytree'):
                _wrap(_n, shutil, _check_first_two())
            _wrap('rmtree', shutil, _check_first())
        except Exception:
            pass

    # ---- 3) 自我标识（便于调试：确认守卫真的加载了） --------------------------
    try:
        sys.__sandbox_guard__ = {
            'dir': _ROOT or None,
            'allow_net': bool(_ALLOW_NET),
        }
    except Exception:
        pass
