FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server vsftpd python3 python3-pyftpdlib python3-openssl openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash fixture && echo 'fixture:container-fixture-password' | chpasswd && mkdir -p /var/run/vsftpd/empty /run/sshd /srv/remote/sftp /srv/remote/ftp /srv/remote/ftps && chown -R fixture:fixture /srv/remote
RUN ssh-keygen -A
COPY tests/fixtures/vsftpd.conf /etc/vsftpd-test.conf
COPY tests/fixtures/remote-services.py /remote-services.py
CMD ["python3", "/remote-services.py"]
