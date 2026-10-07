# 🚀 DeepSeek Harness en AWS (CDK) - Versión Argentina 🇦🇷

**¡Desplegá DeepSeek Harness en AWS en minutos y usalo desde tu navegador!** Este proyecto te ayuda a montar un entorno seguro de [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh web`) en una instancia EC2, accesible solo por SSM Session Manager. El modelo corre en **Amazon Bedrock** (por defecto, y lo más piola) o en la **API directa de DeepSeek**.

## 📱 **¿Qué hacés con esto?**

- **Un asistente de IA para programar** que ejecuta comandos en un ambiente controlado
- **Acceso seguro** sin SSH, sin IPs públicas, todo por AWS Session Manager
- **Modelo en Bedrock** sin tener que manejar claves secretas vos mismo
- **O la API de DeepSeek** si preferís esa opción
- **Control de costos** con tags y budgets que te avisan antes de que se te vaya de mambo 💸

## 🏗️ **¿Cómo funciona la arquitectura?**

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

### ✨ **Las cosas buenas de este setup**

✅ **Sin puertos abiertos al mundo** - `dsh web` solo escucha en el localhost del servidor, porque el bicho ejecuta comandos en la máquina. Todo el acceso es por port forwarding de SSM, sin SSH, sin IP expuesta y sin balanceador.

✅ **Modelo en Bedrock sin andar con secretos** - El CDK crea un rol IAM que solo puede invocar el modelo DeepSeek que elegiste. Un timer de systemd que corre como root asume ese rol cada 20 minutos y deja credenciales temporales (1 hora) que dsh lee con `credential_process`. El agente nunca ve el rol de la instancia.

✅ **Los costos del modelo con tags** - Las llamadas pasan por un *application inference profile* con los tags `app` y `stack`, así el consumo de tokens entra en el budget por tag (mirá [doc/budgets.md](doc/budgets.md) para armar un presupuesto).

✅ **Alternativa: API de DeepSeek** - Con `llmProvider: deepseek-api`, la `DEEPSEEK_API_KEY` va en Secrets Manager y se lee en cada arranque del servicio; no queda en la plantilla ni en la user data para que no se la afanen.

✅ **Aislamiento del agente** - Corre como el usuario sin privilegios `dsh`. Por defecto, una regla de iptables le bloquea el acceso al servicio de metadatos (IMDS), así que los comandos que ejecute el agente no pueden usar las credenciales del rol de la instancia.

✅ **Autenticación de la Web UI** - `dsh` imprime al arrancar una URL con un token de proceso. `scripts/connect.sh` la recupera del journal por SSM.

✅ **Seguro desde el vamos** - La instancia exige IMDSv2 y usa un disco gp3 cifrado. El despliegue espera a que termine el aprovisionamiento (cfn-signal) y falla si algo sale mal.

## 📋 **¿Qué necesitás para arrancar?**

- **Node.js 22+** (o más nuevo)
- **AWS CLI v2** con credenciales configuradas
- **`jq`** (si no lo tenés, `sudo apt install jq` o `brew install jq`)
- **[Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)** para el túnel

> **Tip argentino:** Si todavía no configuraste las credenciales de AWS, andá a [esta guía](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-quickstart.html) y seguí los pasos.

## 🛠️ **Cómo lo usás**

```bash
# 1. Instalá las dependencias
npm install

# 2. Desplegá interactivamente (te hace preguntas)
npm run deploy

# 3. Probá que el modelo funcione
scripts/test-model.sh

# 4. Conectate y andá a la URL
scripts/connect.sh
```

### 🤔 **¿Qué hace `npm run deploy`?**

Te guía paso a paso:

1. **Valida tus credenciales** de AWS y te muestra en qué cuenta estás
2. **Te pide el nombre del stack** - esto identifica tu entorno, así podés tener varios sin mezclarlos
3. **Elegís el proveedor del modelo** (Bedrock o API de DeepSeek) y la región (solo las que tengas habilitadas)
4. **Si elegís Bedrock**, consulta qué modelos DeepSeek ofrece en esa región y te deja elegir
5. **Configurás la red**: crear una VPC nueva (pública o privada con NAT) o usar una existente
6. **Elegís el tipo de instancia** (solo los disponibles en esa región, con datos de vCPU, memoria y arquitectura)
7. **Te muestra un resumen**, confirma y recién ahí escribe el archivo de configuración y ejecuta `cdk deploy`

> **¡Che, ojo!** Si cancelás antes de confirmar, no se guarda nada. Es todo reversible hasta ese momento.

### 🌐 **Con `llmProvider: deepseek-api`**

Tenés que cargar la clave API antes de conectar: `scripts/set-api-key.sh` te la pide, la guarda en Secrets Manager y reinicia el servicio.

## ⚙️ **Configuración (`deploy.config.json`)**

El archivo no existe hasta que corrés `npm run deploy` (está en `.gitignore`). Si querés armarlo a mano, copiá la plantilla:

```bash
cp deploy.config.json.example deploy.config.json
```

Para ver la configuración guardada en cualquier momento:

```bash
npm run show-config
```

### 📊 **Tabla de configuración**

| Clave | Valor por defecto | ¿Qué es? |
|---|---|---|
| `region` | — | Región de AWS del stack (y del modelo en Bedrock) |
| `llmProvider` | `bedrock` | `bedrock` o `deepseek-api` |
| `bedrockModel` | `deepseek.v3.2` | `deepseek.v3.2` o `deepseek.v3-v1:0` (V3.1, en fin de vida el 30/03/2027) |
| `bedrockInferenceProfile` | `true` | Invocar el modelo por un perfil de inferencia con tags |
| `stackName` | `DeepseekHarness` | Nombre del stack |
| `instanceType` | `t4g.large` | Graviton o x86; la AMI se elige según la arquitectura |
| `volumeSizeGiB` | `50` | Disco raíz (workspace y `~/.dsh`) |
| `network` | `{"mode": "new", "privateSubnet": false}` | Red del entorno |
| `dshVersion` | `0.2.0-rc.2` | Versión de `@deepseek-ai/dsh` |
| `nodeMajor` | `22` | Versión mayor de Node.js |
| `webPort` | `3080` | Puerto de la UI (en loopback y en el túnel local) |
| `blockImdsForAgent` | `true` | `false` si querés que el agente use el rol de la instancia |
| `existingSecretArn` | `""` | (opcional, solo `deepseek-api`) Secreto existente con la API key |

### 🌐 **Configuración de red**

`network` tiene dos formas:

```json
{ "mode": "new", "privateSubnet": false }
```
```json
{ "mode": "existing", "vpcId": "vpc-…", "subnetId": "subnet-…", "availabilityZone": "us-east-1a", "subnetType": "public" }
```

- **`new`**: el stack crea su propia VPC. Con `privateSubnet: true` la instancia va en una subred privada con NAT Gateway (~32 USD/mes extra). Consume una VPC y un internet gateway de la cuota de la región (5 de cada uno por defecto).
- **`existing`**: la instancia va en una subred que ya existe. `subnetType` es `public` si la subred sale a internet por un internet gateway (la instancia recibe IP pública) o `private` si sale por un NAT.

> **Atención**: cambiar la red de un stack ya desplegado **reemplaza la instancia** (se pierde el workspace). El menú te avisa cuando pasa esto.

## 💻 **Operación del día a día**

```bash
# Conectate a una shell en la instancia
aws ssm start-session --region <región> --target <InstanceId>

# Mirá los logs del servicio
sudo journalctl -u dsh-web -f

# Logs del aprovisionamiento
sudo cat /var/log/dsh-bootstrap.log

# Estado de la renovación de credenciales de Bedrock
systemctl list-timers dsh-bedrock-credentials.timer
sudo journalctl -u dsh-bedrock-credentials -n 20

# Actualizá dsh sin romper todo
sudo /opt/node/bin/npm install -g @deepseek-ai/dsh@<versión> && sudo systemctl restart dsh-web
```

**Para darle repositorios al agente**, clonalos en `/home/dsh/workspace` (como usuario `dsh`).

## 💰 **Los números (para que no te agarre un infarto)**

### Costo aproximado del stack (us-east-1, configuración por defecto)

| Recurso | USD/mes |
|---|---|
| `t4g.large` encendida 24/7 | ~49 |
| Disco gp3 de 50 GB | ~4 |
| IPv4 pública | ~3,6 |
| Secreto de Secrets Manager (solo `deepseek-api`) | 0,40 |
| NAT Gateway (solo con una VPC nueva y `privateSubnet: true`) | ~33 + tráfico |

La infraestructura suma unos **57 USD/mes** sin subred privada y unos **90 USD/mes** con subred privada.

### Con Bedrock sumás los tokens

Dependen del uso que le des. Como referencia:
- DeepSeek V3.2 en Bedrock: ~0,62 USD por millón de tokens de entrada
- ~1,85 USD por millón de tokens de salida

**Ejemplo de uso moderado**: 5 millones de tokens de entrada y 300.000 de salida por día son unos 3,70 USD/día → unos **80 USD/mes** (22 días hábiles) o **110 USD** si lo usás todos los días.

### Recomendación inicial
- **70 USD** con la API de DeepSeek (solo infraestructura)
- **150 USD** con Bedrock (infraestructura + uso moderado)

> **Argentino tip**: Ajustá el budget después del primer mes con el gasto real. Nadie sabe mejor que vos cómo lo usás.

## ⚠️ **Cosas importantes que tenés que saber**

### Sobre cambios y actualizaciones
- **Cambiar `dshVersion` en el archivo NO actualiza una instancia ya creada** - Tenés que hacerlo con SSM (mirá arriba en "Operación del día a día")
- **`cdk destroy` borra la instancia Y SU DISCO** - Hacé backup del workspace (snapshot de EBS) antes
- **Cambiar el proveedor o el modelo en un stack ya desplegado no reconfigura la instancia** - Hay que recrearla (`npx cdk destroy` y volver a desplegar)
- **Con Bedrock, el modelo por defecto lo fija el deploy** - Se escribe en `~/.dsh/cordis.patch.yml` de la instancia, una capa que la Web UI no puede sobrescribir

### Limitaciones técnicas
- **Límite de salida de 8K tokens** - Bedrock limita las respuestas de DeepSeek a 8.192 tokens (el catálogo de dsh declara más; el deploy lo corrige). Puede quedarse corto para respuestas muy largas.
- **Búsqueda web** - La herramienta `web_search` de dsh usa la API de DeepSeek, así que con Bedrock no funciona (sin `DEEPSEEK_API_KEY` falla al usarse). `web_fetch` sí funciona.
- **Perfil de inferencia** - Bedrock permite crearlos para "la mayoría de los modelos". Si en tu cuenta fallara para DeepSeek, desactivalo con `bedrockInferenceProfile: false`; el consumo del modelo deja de tener tags.

### Sobre costos y tags
- **Todos los recursos llevan los tags `app=deepseek-harness` y `stack=<stackName>`** - Para crear un budget con alertas (y opcionalmente detener la instancia al superarlo), seguí [doc/budgets.md](doc/budgets.md)
- **El secreto de la API** (solo con `deepseek-api`) se borra con `cdk destroy`. Si usás `existingSecretArn`, ese secreto no se toca

## 🆘 **FAQ - Preguntas que seguro te hacés**

### ❓ ¿Es seguro esto?
**Sí, y por varios motivos:**
- Sin puertos abiertos al internet
- Acceso solo por SSM Session Manager (que requiere tus credenciales de AWS)
- El agente corre con usuario sin privilegios
- Bloqueo de IMDS para que el agente no acceda a credenciales de la instancia

### ❓ ¿Puedo tener varias instancias?
¡Sí! Cada stack con nombre diferente es un entorno aparte. Podés tener `dev`, `test`, `proyecto-argentino`, etc.

### ❓ ¿Qué pasa si me quedo sin crédito?
Poné un budget con alertas (80% y 100%) y opcionalmente configuralo para que detenga la instancia automáticamente. La guía está en [doc/budgets.md](doc/budgets.md).

### ❓ ¿Puedo usar esto en mi empresa?
Sí, y es ideal porque los costos quedan taggeados por proyecto/equipo. Cada equipo puede tener su stack con su propio budget.

### ❓ ¿Qué versión de DeepSeek me conviene?
- **V3.2**: La última, mejor performance
- **V3.1**: Más barata pero en fin de vida el 30/03/2027

### ❓ ¿Graviton o x86?
Graviton (t4g, m7g) generalmente sale más barato por tener mejor precio/performance en AWS. Pero elegí según disponibilidad en tu región.

## 📈 **Próximos pasos recomendados**

1. **Primero**: `npm install` y `npm run deploy` para probar
2. **Después**: Configurar budgets con [doc/budgets.md](doc/budgets.md)
3. **Cuando te sientas cómodo**: Clonar tus repos en `/home/dsh/workspace` y que el agente labure con ellos
4. **Pro tip**: Usar `scripts/test-model.sh` para verificar que todo funciona antes de mandarte

## 🐛 **Reportar problemas**

Si encontrás un bug o tenés una sugerencia:
1. Revisá que sea un problema con este CDK y no con DeepSeek Harness mismo
2. Fijate en los logs con `sudo journalctl -u dsh-web -f`
3. Si es algo de la infraestructura, abrí un issue en el [repositorio original](https://github.com/thatwentwell/deepseek-harness-cdk)

---

**¡Éxitos con tu despliegue!** 🎉 

Si te sirvió este proyecto, considerá darle una estrella ⭐ al repo. Y si tenés dudas, preguntá en la comunidad argentina de AWS o en los issues.

> *DeepSeek Harness está en developer preview. Fijá la versión y probá antes de actualizar.*