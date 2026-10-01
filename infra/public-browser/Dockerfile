# Browser process only. Pin this image to the installed Playwright version.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

USER root
COPY entrypoint.sh /usr/local/bin/public-browser-entrypoint
RUN chmod 0555 /usr/local/bin/public-browser-entrypoint

# The image provides the unprivileged pwuser account.  It owns no mounted host
# directory and Chrome uses only the declared tmpfs locations at runtime.
USER pwuser
ENTRYPOINT ["/usr/local/bin/public-browser-entrypoint"]
