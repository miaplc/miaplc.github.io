// ============================================================
//  EspPlc — log-texts.js
//  Testi del log del PLC (pagina Impostazioni e diagnostica).
//  Il firmware salva solo numeri (id, sub, val): qui c'è cosa vogliono
//  dire. Si può tradurre o cambiare senza ricompilare il firmware: sta
//  su SPIFFS insieme alla GUI.
//  level: info | warn | err.  val: come mostrare il valore — un elenco
//  di "vals" oppure mod (modulo uLink: id → nome dalla Diagnostica), ip, bytes, us, crc, scans, mbit, num, where (blocco<<16 | offset), times, numkey (area<<16 | indice).
//  src: provenienza di RUN / STOP; da 256 in su è l'IP dell'editor in rete.
//  repeat: sub con il bit "flag" = stesso evento che si ripete (val = quante volte).
//  (È un .js e non un .json solo perché così si apre anche da file:// sul PC.)
// ============================================================
window.ESPPLC_LOG_TEXTS = {
  "format": "espplc-log-texts",
  "version": 1,
  "lang": "it",
  "ids": {
    "1": {
      "name": "Sistema",
      "subs": {
        "1": {
          "text": "Avvio",
          "level": "warn",
          "val": "reset"
        },
        "2": {
          "text": "Orologio impostato",
          "val": "clk"
        },
        "3": {
          "text": "Log azzerato"
        },
        "4": {
          "text": "Dimensione del log cambiata",
          "val": "bytes"
        },
        "5": {
          "text": "Poca memoria libera",
          "level": "warn",
          "val": "bytes"
        },
        "6": {
          "text": "Riavvio richiesto",
          "level": "warn",
          "val": "restart"
        },
        "7": {
          "text": "Mancanza tensione: ritentiva salvata",
          "level": "warn",
          "val": "vars"
        },
        "8": {
          "text": "Ritentiva ripristinata all'avvio",
          "val": "vars"
        },
        "9": {
          "text": "Controllo di avvio: avviso",
          "level": "warn",
          "val": "bootchk"
        },
        "10": {
          "text": "Errore di sistema (SF) attivo — il PLC resta in RUN",
          "level": "err",
          "val": "bootchk"
        },
        "11": {
          "text": "Errore di sistema (SF) risolto",
          "val": "bootchk"
        },
        "12": {
          "text": "Prima di questo avvio: mancanza tensione (ingresso di mancanza tensione)",
          "level": "warn"
        },
        "13": {
          "text": "File salvati a metà da una mancanza di corrente: ripristinati quelli nuovi",
          "val": "files"
        },
        "14": {
          "text": "Salvataggio interrotto da una mancanza di corrente: tenuti i file di prima",
          "val": "files"
        },
        "15": {
          "text": "Log non salvato in flash: spazio dei file esaurito (in flash resta quello di prima, si riprova ogni minuto)",
          "level": "warn",
          "val": "bytes"
        },
        "16": {
          "text": "Rete e USB ferme per alcuni secondi (il PLC ha continuato): secondi",
          "level": "warn",
          "val": "num"
        }
      }
    },
    "2": {
      "name": "PLC",
      "subs": {
        "1": {
          "text": "RUN",
          "val": "src"
        },
        "2": {
          "text": "STOP",
          "level": "warn",
          "val": "src"
        },
        "3": {
          "text": "Nessun programma",
          "val": "src"
        },
        "4": {
          "text": "Fault azzerato",
          "val": "fault"
        },
        "6": {
          "text": "StartUp eseguito",
          "val": "us"
        }
      }
    },
    "3": {
      "name": "Fault",
      "level": "err",
      "sub_is": "fault",
      "text": "PLC in STOP per errore",
      "val": "scans"
    },
    "4": {
      "name": "Programma",
      "subs": {
        "1": {
          "text": "Programma caricato in RAM",
          "val": "crc"
        },
        "2": {
          "text": "Programma salvato in flash",
          "val": "crc"
        },
        "3": {
          "text": "Programma cancellato",
          "level": "warn"
        },
        "4": {
          "text": "Programma caricato dalla flash all'avvio",
          "val": "crc"
        },
        "5": {
          "text": "Programma rifiutato",
          "level": "warn",
          "val": "fault"
        },
        "6": {
          "text": "Nessun programma in flash all'avvio"
        },
        "7": {
          "text": "Caricati solo i blocchi cambiati (tra due scansioni)",
          "val": "crc"
        },
        "8": {
          "text": "Download a blocchi rifiutato",
          "level": "warn",
          "val": "patch"
        }
      }
    },
    "5": {
      "name": "Watchdog",
      "level": "err",
      "subs": {
        "1": {
          "text": "Scansione troppo lunga: PLC fermato, uscite in stato sicuro",
          "val": "us"
        },
        "2": {
          "text": "Limite istruzioni per scansione superato"
        },
        "3": {
          "text": "Ingressi non riletti in tempo (controllo del ciclo): PLC fermato, uscite spente",
          "val": "ms"
        }
      }
    },
    "6": {
      "name": "Rete",
      "subs": {
        "1": {
          "text": "WiFi verso il router connesso",
          "val": "ip"
        },
        "2": {
          "text": "WiFi verso il router perso",
          "level": "warn"
        },
        "3": {
          "text": "Ethernet connesso",
          "val": "ip"
        },
        "4": {
          "text": "Ethernet perso",
          "level": "warn"
        },
        "5": {
          "text": "Access point del PLC attivo",
          "val": "ip"
        },
        "6": {
          "text": "Impostazioni di rete di fabbrica (3 accensioni di fila)",
          "level": "warn"
        },
        "7": {
          "text": "Access point chiuso: router collegato e stabile (secondi di attesa)",
          "val": "num"
        },
        "8": {
          "text": "Access point riaperto: router non raggiungibile (secondi)",
          "level": "warn",
          "val": "num"
        },
        "9": {
          "text": "Ethernet: nessun dato ricevuto, driver riavviato (secondi di silenzio)",
          "level": "warn",
          "val": "num"
        },
        "10": {
          "text": "Pannello HMI collegato da",
          "val": "ip"
        },
        "11": {
          "text": "Pannello HMI scollegato",
          "level": "warn",
          "val": "ip"
        },
        "12": {
          "text": "Esposizione dati: programma collegato da",
          "val": "ip"
        },
        "13": {
          "text": "Esposizione dati: programma non più attivo (10 s senza richieste)",
          "val": "ip"
        },
        "14": {
          "text": "Ethernet: riavvio del driver non riuscito (codici di stop e di start)",
          "level": "err",
          "val": "stopstart"
        },
        "15": {
          "text": "Bus I/O: dispositivi impostati",
          "val": "num"
        },
        "16": {
          "text": "Dispositivo I/O",
          "val": "busstate"
        },
        "17": {
          "text": "uLink: modulo perso",
          "level": "warn",
          "val": "mod"
        },
        "18": {
          "text": "uLink: modulo tornato in RUN",
          "val": "mod"
        },
        "19": {
          "text": "uLink: modulo con la configurazione cambiata, da abbinare di nuovo",
          "level": "warn",
          "val": "mod"
        },
        "20": {
          "text": "pPlc al modulo appena abbinato",
          "val": "ppauto"
        }
      }
    },
    "7": {
      "name": "Editor",
      "subs": {
        "1": {
          "text": "Download del programma da",
          "val": "ip"
        },
        "2": {
          "text": "Merker scritto da editor",
          "val": "mbit"
        },
        "3": {
          "text": "Tabella simboli salvata",
          "val": "bytes"
        },
        "4": {
          "text": "Impostazioni del PLC cambiate",
          "val": "setcode_plc"
        },
        "5": {
          "text": "Valore scritto da editor",
          "val": "numkey"
        },
        "6": {
          "text": "Impostazioni di rete cambiate",
          "val": "setcode_net"
        }
      }
    },
    "8": {
      "name": "Firmware (OTA)",
      "subs": {
        "1": {
          "text": "Aggiornamento firmware iniziato",
          "level": "warn"
        },
        "2": {
          "text": "Aggiornamento firmware completato",
          "level": "warn"
        },
        "3": {
          "text": "Aggiornamento firmware fallito",
          "level": "err"
        },
        "4": {
          "text": "Ritorno al firmware precedente (rollback)",
          "level": "err"
        }
      }
    },
    "9": {
      "name": "Errore programma",
      "level": "warn",
      "sub_is": "fault",
      "text": "Errore nel programma",
      "val": "where",
      "flags": [
        { "flag": 256, "text": "Errore nel programma, continua", "val": "where" },
        { "flag": 512, "text": "Errore nel programma terminato", "val": "where", "level": "info" }
      ]
    }
  },
  "setcode": {
    "plc": ["ruolo della scheda (0 PLC, 1 modulo I/O)", "al riavvio (0 ultimo stato, 1 sempre RUN)", "controllo del ciclo",
            "uLink, modulo perso (0 riarmo automatico, 1 riarmo manuale, 2 STOP se manca un modulo, 3 STOP su guasto nuovo)",
            "diagnostica avanzata (0 spenta, 1 accesa)", "protezione reset USB: GPIO", "protezione reset USB: livello (0 basso, 1 alto)",
            "rete usata dal programma (0 nessuna, 1 Ethernet, 2 WiFi, 3 Ethernet o WiFi)", "tempo concesso alla rete all'avvio",
            "ingressi", "uscite", "mancanza tensione: GPIO", "mancanza tensione: attivo a (0 uno, 1 zero)",
            "VM + IRAM (0 spenta, 1 accesa)", "RAM libera in STOP (0 spenta, 1 accesa)", "VM accu (0 spenta, 1 accesa)", "VM codice macchina (0 spenta, 1 accesa)"],
    "net": ["WiFi (0 spento, 1 acceso)", "nome del PLC", "access point: SSID", "access point: password", "access point: IP", "access point: canale",
            "access point spento con il router collegato (0 no, 1 sì)", "router: SSID", "router: password", "WiFi verso il router (0 spento, 1 acceso)",
            "router: DHCP (0 IP fisso, 1 DHCP)", "router: IP, maschera, gateway, DNS", "Ethernet (0 spenta, 1 accesa)",
            "Ethernet: DHCP (0 IP fisso, 1 DHCP)", "Ethernet: IP, maschera, gateway, DNS", "editor dalla rete (0 tutte, 1 solo Ethernet, 2 solo WiFi)"]
  },
  "vals": {
    "clk": {
      "1": "dall'orologio DS3231",
      "2": "dal PC (editor)",
      "3": "dalla rete (NTP)"
    },
    "reset": {
      "0": "motivo sconosciuto",
      "1": "accensione",
      "2": "pulsante / pin di reset",
      "3": "riavvio software",
      "4": "crash del firmware (panic)",
      "5": "watchdog (interrupt)",
      "6": "watchdog (task bloccato)",
      "7": "watchdog RTC (anche pulsante di reset)",
      "8": "risveglio dal deep sleep",
      "9": "brownout: tensione di alimentazione bassa",
      "10": "SDIO"
    },
    "restart": {
      "1": "aggiornamento OTA",
      "2": "nuova configurazione",
      "3": "factory reset"
    },
    "ppauto": {
      "0": "programma scaricato",
      "1": "hardware del modulo diverso: programma non scaricato",
      "2": "firmware del modulo diverso: programma non scaricato",
      "3": "invio non riuscito",
      "4": "picoPlc spento nel modulo"
    },
    "busstate": {
      "1": "bloccato: uscite spente, serve il riarmo",
      "2": "riarmo in corso",
      "3": "RUN: uscite dal PLC",
      "4": "manca il PLC: pPlc in RUN",
      "5": "PLC tornato: pPlc in STOP"
    },
    "src": {
      "0": "all'avvio",
      "1": "da editor / REST",
      "2": "all'avvio: era in STOP prima del riavvio",
      "3": "all'avvio: dopo un errore grave del firmware",
      "4": "all'avvio: scelta dell'operatore al riavvio",
      "5": "dall'editor via USB",
      "6": "per il Download",
      "7": "per il riavvio del PLC",
      "8": "nel PLC, senza richiesta",
      "9": "modulo I/O non raggiungibile"
    },
    "bootchk": {
      "1": "impostazioni del PLC non valide: valori di default",
      "2": "GPIO del PLC usato anche dall'Ethernet",
      "3": "ritentiva illeggibile: valori a 0",
      "4": "poca memoria libera",
      "5": "programma in flash non valido",
      "6": "memoria insufficiente per il PLC",
      "7": "bus I2C: dispositivo assente",
      "8": "bus SPI: dispositivo assente",
      "9": "rete usata dal PLC non disponibile",
      "10": "errore nel programma in corso",
      "11": "impostazioni di rete non valide: rete di fabbrica",
      "12": "access point con la password di fabbrica",
      "13": "3 accensioni di fila: impostazioni di rete di fabbrica",
      "14": "riavvio dopo un errore grave del firmware: PLC in STOP"
    },
    "fault": {
      "0": "nessuno",
      "1": "scansione troppo lunga",
      "2": "limite istruzioni",
      "3": "istruzione non valida",
      "4": "stack overflow",
      "5": "divisione per zero",
      "6": "riferimento I/O non valido",
      "7": "CRC errato o programma troppo grande",
      "8": "versione programma errata",
      "9": "lettura dalla flash fallita",
      "10": "programma troppo grande per il PLC",
      "11": "tabella dei blocchi non valida",
      "12": "overflow (risultato fuori dal campo del tipo)",
      "13": "ingressi non riletti in tempo (controllo del ciclo)",
      "14": "uLink fault: modulo I/O perso o con la configurazione cambiata",
      "15": "indice di un array fuori dai limiti",
      "16": "tabelle I/O fatte per un'altra scheda"
    },
    "patch": {
      "1": "il programma sul PLC è cambiato: serve il download completo",
      "2": "memoria insufficiente: serve STOP e download completo",
      "3": "dati errati",
      "4": "nessun programma sul PLC"
    }
  }
};
