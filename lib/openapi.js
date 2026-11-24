// Specifica OpenAPI 3.0 dei due endpoint di translator.js, come oggetto JS (niente
// parser YAML a runtime). Riflette esattamente i codici/corpi di risposta già
// implementati — non un contratto aspirazionale.
// Pipeline: montata da translator.js su /docs via swagger-ui-express.
module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'OGC HTML Translator',
    version: '1.0.0',
    description: 'Riceve un processo OGC e lo traduce in un form HTML autosufficiente, in background. Il risultato va su file e, se configurato, viene inviato a un callback esterno.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/translate': {
      post: {
        summary: 'Avvia la traduzione di un processo OGC',
        description: 'Accetta il job immediatamente (202) e lo elabora in background. Il risultato va recuperato con GET /translate/{translationId}, o ricevuto via callback se CALLBACK_URL è configurata.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OgcProcess' },
            },
          },
        },
        responses: {
          202: {
            description: 'Job accettato, in elaborazione',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { translationId: { type: 'string', format: 'uuid' } },
                  required: ['translationId'],
                },
              },
            },
          },
          403: {
            description: 'Richiesta da fuori dalla rete locale (vedi ALLOWED_NETWORKS)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
          400: {
            description: 'Processo non valido o modello non consentito',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/translate/{translationId}': {
      get: {
        summary: 'Recupera lo stato/risultato di un job',
        parameters: [{
          name: 'translationId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        }],
        responses: {
          200: {
            description: 'Stato del job: "pending" (ancora in corso) o "done" (con l\'HTML generato)',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/JobPending' },
                    { $ref: '#/components/schemas/JobDone' },
                  ],
                },
              },
            },
          },
          403: {
            description: 'Richiesta da fuori dalla rete locale (vedi ALLOWED_NETWORKS)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          },
          404: {
            description: 'translationId sconosciuto',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          500: {
            description: 'Il job è fallito durante la generazione',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/JobError' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      OgcProcess: {
        type: 'object',
        required: ['id', 'inputs'],
        properties: {
          id: { type: 'string', description: 'Identificatore del processo OGC.' },
          title: { type: 'string' },
          description: { type: 'string' },
          model: {
            type: 'string',
            description: 'Modello Ollama da usare per i campi non riconosciuti staticamente. Deve essere tra quelli consentiti da OLLAMA_ALLOWED_MODELS.',
          },
          inputs: {
            type: 'object',
            description: 'Mappa nome-campo -> definizione del campo (title/description/minOccurs/maxOccurs/schema), nello stesso formato di un elemento di processes.json.',
            additionalProperties: true,
          },
        },
      },
      JobPending: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['pending'] } },
        required: ['status'],
      },
      JobDone: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['done'] },
          html: { type: 'string', description: 'La pagina HTML generata, completa.' },
          log: {
            type: 'array',
            description: 'Un elemento per campo tradotto: da dove viene (static/llm/llm-geo/fallback), con quale kind/modello, e quanto ha richiesto.',
            items: { type: 'object', additionalProperties: true },
          },
        },
        required: ['status', 'html', 'log'],
      },
      JobError: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['error'] },
          error: { type: 'string' },
        },
        required: ['status', 'error'],
      },
      ErrorResponse: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
    },
  },
};
