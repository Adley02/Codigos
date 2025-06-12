const fs = require('fs');
const https = require('https');
const SerialPort = require('serialport');
const Readline = SerialPort.parsers.Readline;
const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const WebSocket = require('ws'); // WebSocket seguro


// Configura os pinos UART
const pinsToConfigure = [
  { pin: 'P9_11', mode: 'uart' },
  { pin: 'P9_13', mode: 'uart' }
];


function configurePins() {
  return Promise.all(pinsToConfigure.map(pin => {
    return new Promise((resolve, reject) => {
      const cmd = `config-pin ${pin.pin} ${pin.mode}`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          console.error(`Erro ao configurar o pino ${pin.pin}: ${stderr}`);
          reject(error);
        } else {
          console.log(`Pino ${pin.pin} configurado para modo ${pin.mode}.`);
          resolve(stdout);
        }
      });
    });
  }));
}


// Carrega os certificados SSL
const options = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'ca.key')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'ca.crt'))
};


// Inicializa o servidor HTTPS
const app = express();
const server = https.createServer(options, app);
const wss = new WebSocket.Server({ server });


app.use(express.static('public'));


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Servidor HTTPS rodando na porta ${PORT}`);
});


const THINGSPEAK_WRITE_KEY = 'RQW6ZDFV8LVFAUU8';


function enviarDadosParaThingSpeak(lat, lon) {
  if (lat === undefined || lon === undefined) return;


  const url = `https://api.thingspeak.com/update?api_key=${THINGSPEAK_WRITE_KEY}&field1=${lat}&field2=${lon}`;


  https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode === 200 && data !== '0') {
        console.log(`Dados enviados para ThingSpeak. Entry ID: ${data}`);
      } else {
        console.error(`Erro ao enviar para ThingSpeak: ${data}`);
      }
    });
  }).on('error', (err) => {
    console.error('Erro no envio para ThingSpeak:', err);
  });
}


let currentLocation = null;


wss.on('connection', (ws) => {
  console.log('Cliente WebSocket conectado');
  if (currentLocation) {
    ws.send(JSON.stringify(currentLocation));
  }
});

// Funções de conversão de coordenadas (copiadas do seu segundo código de exemplo)
function convertToDecimal(coord, direction) {
    if (!coord || coord.length < 4 || isNaN(parseFloat(coord))) {
        console.warn(`Coordenada NMEA inválida recebida: "${coord}"`);
        return 0;
    }

    const pointIndex = coord.indexOf('.');
    if (pointIndex === -1) {
        console.error(`Ponto decimal não encontrado na coordenada: ${coord}`);
        return 0;
    }

    let degreesLength;

    const partBeforePoint = coord.substring(0, pointIndex);

    if (partBeforePoint.length === 4 || partBeforePoint.length === 5) {
        if (partBeforePoint.length === 4) { // Assumindo DDMM.MMMM (Latitude)
            degreesLength = 2;
        } else { // Assumindo DDDMM.MMMM (Longitude)
            degreesLength = 3;
        }
    } else {
        console.warn(`Formato de coordenada NMEA inesperado: "${coord}"`);
        return 0;
    }

    const degrees = parseFloat(coord.slice(0, degreesLength));
    const minutes = parseFloat(coord.slice(degreesLength));

    if (isNaN(degrees) || isNaN(minutes)) {
        console.error(`Falha ao parsear graus ou minutos: ${coord}`);
        return 0;
    }

    let decimal = degrees + (minutes / 60);
    if (direction === 'S' || direction === 'W') {
        decimal *= -1;
    }
    return decimal;
}


async function main() {
  try {
    await configurePins();
    console.log('Pinos UART configurados.');


    const serialPort = new SerialPort('/dev/ttyO4', { baudRate: 9600 });
    const parser = serialPort.pipe(new Readline({ delimiter: '\r\n' }));


    serialPort.on('open', () => console.log('Porta serial aberta.'));
    serialPort.on('error', err => console.error('Erro na serial:', err.message));


    parser.on('data', (data) => {
      data = data.trim();
      console.log('Dados da serial:', data); // Adicionado para depuração


      // Altera a condição para '$GNGGA'
      if (data.startsWith('$GNGGA')) {
        const fields = data.split(',');

        // Para GNGGA:
        // fields[2] = Latitude
        // fields[3] = Latitude Direction (N/S)
        // fields[4] = Longitude
        // fields[5] = Longitude Direction (E/W)
        // fields[6] = GPS Quality Indicator (0 = Invalid, 1 = GPS fix, 2 = DGPS fix, etc.)

        // Verifica se há dados suficientes na frase e se a qualidade do fix é válida (não '0')
        if (fields.length >= 7 && fields[6] !== '0') {
            const latitudeNMEA = fields[2];
            const latitudeDirection = fields[3];
            const longitudeNMEA = fields[4];
            const longitudeDirection = fields[5];

            if (latitudeNMEA && latitudeDirection && longitudeNMEA && longitudeDirection) {
                try {
                    const lat = convertToDecimal(latitudeNMEA, latitudeDirection);
                    const lon = convertToDecimal(longitudeNMEA, longitudeDirection);

                    if (lat !== 0 || lon !== 0) {
                        currentLocation = { latitude: lat, longitude: lon };
                        console.log('Localização recebida (GNGGA processada):', currentLocation);

                        // Envia via WebSocket para todos os clientes
                        wss.clients.forEach((client) => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify(currentLocation));
                            }
                        });
                    } else {
                        console.log('Coordenadas 0,0 ou inválidas após conversão GNGGA.');
                    }
                } catch (e) {
                    console.error('Erro ao converter coordenadas GNGGA:', e.message);
                }
            } else {
                console.log('Dados GNGGA incompletos, não processando.');
            }
        } else {
            console.log(`Status GNGGA inválido ou sem fix: ${fields[6]}`);
        }
      }
    });


    setInterval(() => {
      if (currentLocation) {
        enviarDadosParaThingSpeak(currentLocation.latitude, currentLocation.longitude);
      }
    }, 15000);


  } catch (err) {
    console.error('Erro na inicialização:', err);
  }
}


main();
