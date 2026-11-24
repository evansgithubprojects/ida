# The payments service. The `sdk` build context is the repo's python/ folder (see compose.yaml).
FROM python:3.12-slim
WORKDIR /app
COPY --from=sdk pyproject.toml README.md /sdk/
COPY --from=sdk src /sdk/src
RUN pip install --no-cache-dir "/sdk[kafka,rabbitmq]"
COPY payments.py ./
# Unbuffered, so its log lines show up in `docker compose logs` as they happen.
ENV PYTHONUNBUFFERED=1
CMD ["python", "payments.py"]
