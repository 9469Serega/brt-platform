# -*- mode: python ; coding: utf-8 -*-
block_cipher = None

a = Analysis(
    ['brt_node.py'],
    pathex=['.'],
    binaries=[],
    datas=[],
    hiddenimports=[
        'brt_chain',
        'flask', 'flask_cors', 'flask.json',
        'werkzeug', 'werkzeug.serving', 'werkzeug.debug',
        'jinja2', 'click', 'itsdangerous',
        'websockets', 'websockets.legacy', 'websockets.legacy.server',
        'websockets.legacy.client', 'websockets.exceptions',
        'websockets.frames', 'websockets.http11', 'websockets.uri',
        'ecdsa', 'ecdsa.keys', 'ecdsa.curves', 'ecdsa.ellipticcurve',
        'ecdsa.numbertheory', 'ecdsa.ecdsa', 'ecdsa.der',
        'base58', 'hashlib', 'secrets', 'threading', 'asyncio',
        'collections', 'dataclasses', 'json', 'os', 'sys', 'time',
        'engineio', 'engineio.async_drivers',
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'numpy', 'PIL', 'PyQt5', 'wx'],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='brt_node',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    icon=None,
)
