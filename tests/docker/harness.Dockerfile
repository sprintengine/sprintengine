# The harness's desktop image: the app image (app.Dockerfile) plus the entry
# script and the stand-in CLIs, in a layer of their own so changing them does
# not rebuild the app.
ARG APP_IMAGE
FROM ${APP_IMAGE}
USER root
COPY app-entry.sh /opt/studio-harness/app-entry.sh
COPY bin/ /opt/studio-harness/bin/
RUN chmod 755 /opt/studio-harness/app-entry.sh /opt/studio-harness/bin/*
ENV PATH=/opt/studio-harness/bin:$PATH
ENTRYPOINT ["/opt/studio-harness/app-entry.sh"]
