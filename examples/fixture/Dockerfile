FROM node:26.13.0-slim
ARG MODE=hello
ARG VERSION=v1
ENV MODE=${MODE} VERSION=${VERSION}
COPY server.mjs /app/server.mjs
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
