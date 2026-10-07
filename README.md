# DeepSeek Harness en AWS (CDK)

Despliega [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh web`) en una instancia EC2, accesible solo a través de SSM Session Manager. El modelo corre en **Amazon Bedrock** (por defecto) o en la **API de DeepSeek**.

## Arquitectura

```
tu navegador ──► localhost:3080 ──(túnel SSM)──► EC2 (Amazon Linux 2023)
                                                  └─ systemd: dsh-web
                                                     dsh --profile web --host 127.0.0.1
                                                     usuario "dsh", workspace /home/dsh/workspace
                                                        │
                                  credenciales temporales (rol solo-Bedrock)
                                                        ▼
                                  Amazon Bedrock ── perfil de inferencia (tags) ── DeepSeek V3.2
```

- **Sin puertos de entrada.** `dsh web` solo escucha en loopback y rechaza `0.0.0.0` a propósito, porque el agente ejecuta comandos en la máquina. El acceso es por port forwarding de SSM, sin SSH, sin IP expuesta y sin balanceador.
- **Modelo en Bedrock sin secretos.** El CDK crea un rol IAM que solo puede invocar el modelo DeepSeek elegido. Un timer de systemd que corre como root asume ese rol cada 20 minutos y deja credenciales temporales (1 h) que dsh lee con `credential_process`. El agente nunca ve el rol de la instancia.
- **Costos del modelo con tags.** Las llamadas pasan por un *application inference profile* con los tags `app` y `stack`, así el consumo de tokens entra en el budget por tag (ver [doc/budgets.md](doc/budgets.md)).
- **Alternativa: API de DeepSeek.** Con `llmProvider: deepseek-api`, la `DEEPSEEK_API_KEY` va en Secrets Manager y se lee en cada arranque del servicio; no queda en la plantilla ni en la user data.
- **Aislamiento del agente.** Corre como el usuario sin privilegios `dsh`. Por defecto, una regla de iptables le bloquea el acceso al servicio de metadatos (IMDS), así que los comandos que ejecute el agente no pueden usar las credenciales del rol de la instancia.
- **Autenticación de la UI.** `dsh` imprime al arrancar una URL con un token de proceso. `scripts/connect.sh` la recupera del journal por SSM.
- La instancia exige IMDSv2 y usa un disco gp3 cifrado. El despliegue espera a que termine el aprovisionamiento (cfn-signal) y falla si algo sale mal.

## Requisitos

- Node.js 22+, AWS CLI v2 con credenciales y `jq`
- [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) para el túnel

## Uso

```bash
npm install
npm run deploy              # menú: proveedor, región, modelo, instancia y opciones avanzadas
scripts/test-model.sh       # prueba el modelo desde la instancia, con las credenciales del agente
scripts/connect.sh          # abre el túnel e imprime la URL con token
```

Con `llmProvider: deepseek-api`, antes de conectarte cargá la clave con `scripts/set-api-key.sh` (la pide, la guarda en Secrets Manager y reinicia el servicio).

`npm run deploy` hace lo siguiente:

1. Valida las credenciales de AWS y muestra la cuenta de destino.
2. Pide el proveedor del modelo (Bedrock o API de DeepSeek) y la región (solo las habilitadas en la cuenta). Con Bedrock, consulta qué modelos DeepSeek ofrece esa región y te deja elegir; si no hay ninguno, te propone otra región o usar la API.
3. Pide el tipo de instancia (solo los disponibles en esa región, con vCPU, memoria y arquitectura). Opcionalmente, nombre del stack, disco y subred privada.
4. Verifica el destino. Ofrece hacer el `cdk bootstrap` si la región no lo tiene, avisa si ya hay un stack desplegado en otra región y avisa si cambiar el tipo de instancia la va a reiniciar.
5. Muestra un resumen y, recién al confirmar, escribe `deploy.config.json` y ejecuta `cdk deploy`. Si cancelás antes, no se guarda nada.
6. Al terminar, muestra la configuración, los outputs del stack y los próximos pasos.

Abrí la URL que imprime `connect.sh` (`http://127.0.0.1:3080/...`) mientras el túnel esté abierto.

## Configuración (`deploy.config.json`)

El archivo no existe hasta que corrés `npm run deploy` (está en `.gitignore`). Para armarlo a mano, copiá la plantilla:

```bash
cp deploy.config.json.example deploy.config.json
```

Para ver la configuración guardada en cualquier momento:

```bash
npm run show-config
```

| Clave | Por defecto | Descripción |
|---|---|---|
| `region` | — | Región de AWS del stack (y del modelo en Bedrock) |
| `llmProvider` | `bedrock` | `bedrock` o `deepseek-api` |
| `bedrockModel` | `deepseek.v3.2` | `deepseek.v3.2` o `deepseek.v3-v1:0` (V3.1, en fin de vida el 30/03/2027) |
| `bedrockInferenceProfile` | `true` | Invocar el modelo a través de un perfil de inferencia con tags |
| `stackName` | `DeepseekHarness` | Nombre del stack |
| `instanceType` | `t4g.large` | Graviton o x86; la AMI se elige según la arquitectura |
| `volumeSizeGiB` | `50` | Disco raíz (workspace y `~/.dsh`) |
| `privateSubnet` | `false` | `true`: subred privada + NAT Gateway (~32 USD/mes extra) |
| `dshVersion` | `0.2.0-rc.2` | Versión de `@deepseek-ai/dsh` |
| `nodeMajor` | `22` | Versión mayor de Node.js |
| `webPort` | `3080` | Puerto de la UI (en loopback y en el túnel local) |
| `blockImdsForAgent` | `true` | `false` si querés que el agente use el rol de la instancia |
| `vpcId` | `""` | (opcional) VPC existente |
| `existingSecretArn` | `""` | (opcional, solo `deepseek-api`) Secreto existente con la API key |

Después de editar el archivo a mano, volvé a ejecutar `npm run deploy` (el menú propone los valores guardados) o `npx cdk deploy` (sin menú). Un `-c clave=valor` en la línea de comandos tiene prioridad sobre el archivo, por ejemplo `npx cdk deploy -c instanceType=m7g.xlarge`. Todos los comandos de `cdk` (`synth`, `diff`, `destroy`) y los scripts `set-api-key.sh`, `test-model.sh` y `connect.sh` usan la región y el stack de este archivo, y fallan con un mensaje claro si no existe o le faltan parámetros.

## Operación

```bash
# Shell en la instancia
aws ssm start-session --region <región> --target <InstanceId>
# Logs del servicio / del aprovisionamiento
sudo journalctl -u dsh-web -f
sudo cat /var/log/dsh-bootstrap.log
# Estado de la renovación de credenciales de Bedrock
systemctl list-timers dsh-bedrock-credentials.timer
sudo journalctl -u dsh-bedrock-credentials -n 20
# Actualizar dsh en caliente
sudo /opt/node/bin/npm install -g @deepseek-ai/dsh@<versión> && sudo systemctl restart dsh-web
```

Para darle repos al agente, clónalos en `/home/dsh/workspace` (como usuario `dsh`).

## Notas

- Cambiar `dshVersion` en el archivo **no** actualiza una instancia ya creada (la user data solo corre al crearla, para no perder el workspace). Actualizá por SSM como se indica arriba.
- `cdk destroy` borra la instancia **y su disco**. Haz backup del workspace (snapshot de EBS) antes.
- **Cambiar el proveedor o el modelo en un stack ya desplegado no reconfigura la instancia.** La configuración de dsh se escribe al crearla. Para aplicar el cambio hay que recrearla (`npx cdk destroy` y volver a desplegar); el menú lo avisa.
- **Con Bedrock, el modelo por defecto lo fija el deploy.** Se escribe en `~/.dsh/cordis.patch.yml` de la instancia, una capa que la Web UI no puede sobrescribir.
- **Límite de salida de 8K tokens.** Bedrock limita las respuestas de DeepSeek a 8.192 tokens (el catálogo de dsh declara más; el deploy lo corrige). Puede quedarse corto para respuestas muy largas.
- **Búsqueda web.** La herramienta `web_search` de dsh usa la API de DeepSeek, así que con Bedrock no funciona (sin `DEEPSEEK_API_KEY` falla al usarse). `web_fetch` sí funciona.
- **Perfil de inferencia.** Bedrock permite crearlos para "la mayoría de los modelos". Si en tu cuenta fallara para DeepSeek, desactivalo con `bedrockInferenceProfile: false`; el consumo del modelo deja de tener tags.
- El secreto de la API (solo con `deepseek-api`) se borra con `cdk destroy`. Si usas `existingSecretArn`, ese secreto no se toca.
- **Costos:** todos los recursos llevan los tags `app=deepseek-harness` y `stack=<stackName>`, y el disco los hereda de la instancia. Para crear un budget con alertas (y opcionalmente detener la instancia al superarlo), seguí [doc/budgets.md](doc/budgets.md).
- DeepSeek Harness está en *developer preview*. Fija la versión y prueba antes de actualizar.
