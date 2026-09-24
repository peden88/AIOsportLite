FROM node:22-slim

WORKDIR /app

# Fonts for the rasterised catalog cards. The card SVGs are rendered to JPEG
# server-side because Nuvio does not draw SVG posters, and a container with no
# fonts renders every label as nothing at all — silently, with the artwork
# otherwise intact.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig ffmpeg \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

# Copy package configs and install dependencies
COPY package*.json ./
RUN npm install

# Copy source code and assets
COPY . .

# A build identifier. .dockerignore keeps .git out of the context, so the image
# has no commit to report and `git rev-parse` here would only fail. A UTC stamp
# answers the question people actually ask of it -- "is this the build I just
# made?" -- and this layer is rebuilt whenever the COPY above changes, which is
# exactly when the answer differs.
#
# BUILD_SHA is honoured when a caller passes one (docker build --build-arg
# BUILD_SHA=$(git rev-parse --short HEAD)); it is simply absent otherwise.
ARG BUILD_SHA=""
RUN date -u +%Y.%m.%d.%H%M > /app/BUILD_ID \
 && printf '%s' "$BUILD_SHA" > /app/BUILD_SHA

# Install internal resolver dependencies
RUN cd resolver && npm install

# Build the bundled distribution
RUN npm run build

# Configure runtime environment
ENV PORT=7000
ENV NODE_ENV=production
EXPOSE 7000

# Lets Docker report the container as unhealthy, not merely running. The slim
# image has no curl, so node asks.
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Start server directly with node
CMD ["node", "dist/index.js"]

