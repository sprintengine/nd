# syntax=docker/dockerfile:1@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

# The end-to-end tests' stateful Stripe, in front of stripe-mock (see
# server.ts). Test-only: never deployed. Build from this directory:
#
#   docker build -t nd-stripe-double tests/e2e/stripe-double

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:a84242e747fbb5aaaa0180c273b6f7130ca34b3300082192ef58eea96089eb3c

WORKDIR /app
COPY server.ts ./server.ts
USER 65532:65532
EXPOSE 12112

# Node runs the TypeScript directly (type stripping); it needs no packages.
CMD ["server.ts"]
