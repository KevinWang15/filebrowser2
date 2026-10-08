"""Disposable native protocol fixtures; no production defaults."""
import os, subprocess, signal
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '/tmp/ftp.key', '-out', '/tmp/ftp.crt', '-days', '3', '-subj', '/CN=remotes', '-addext', 'subjectAltName=DNS:remotes'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.Popen(['/usr/sbin/sshd', '-D', '-o', 'PasswordAuthentication=yes', '-o', 'PermitRootLogin=no', '-o', 'LogLevel=ERROR'])
authorizer = DummyAuthorizer()
authorizer.add_user('fixture', 'container-fixture-password', '/srv/remote', perm='elradfmwMT')
subprocess.Popen(['/usr/sbin/vsftpd', '/etc/vsftpd-test.conf'])
for port, base in [(2121, FTPHandler)]:
    class Handler(base): pass
    Handler.authorizer = authorizer
    Handler.passive_ports = range(30100 if port == 2121 else 30200, 30150 if port == 2121 else 30250)
    # Each daemon owns its async loop in a separate process.
    if os.fork() == 0:
        FTPServer(('0.0.0.0', port), Handler).serve_forever()
        os._exit(0)
print('Remote fixtures ready', flush=True)
signal.pause()
