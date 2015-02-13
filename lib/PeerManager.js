var settings = require('./settings');
var events = require('events');
var util = require('util');
var Peer = require('TLS-p2p-node').Peer;
var tls = require('tls')
var net = require('net')
var _ = require('underscore')


var PeerManager = exports.PeerManager = function PeerManager(options) {
  events.EventEmitter.call(this);

  options = _.extend(settings.defaultOptions, options);
  options.port = parseInt(options.port);
  options.magic = parseInt(options.magic);
  options.minPeers = parseInt(options.minPeers);
  options.maxPeers = parseInt(options.maxPeers);
  
  this.options = options;
  
  this.live = {};
  this.liveCount = 0;
  this.server = false;
  
  this.available = [];
  this.badPeers = {};
  
  var _state = 'new';
  Object.defineProperty(this, 'state', {
    enumerable: true,
    get: function() {
      return _state;
    },
    set: function(newVal) {
      var oldVal = _state;
      this.emit('stateChange', {new: newVal, old: oldVal});
      _state = newVal;
    }
  });
  
  return this;
}
util.inherits(PeerManager, events.EventEmitter);

PeerManager.prototype.initiate = function initiate(seedPeers) {
  this.state = 'initiating';
  
  if (seedPeers) this.addPool(seedPeers); // Open connections to seed peers
  if (this.options.listen) this.openListener(); // Listen for incoming connections
  
  var self = this;
  setImmediate(function() { self.checkPeers(); }); // Attempt to fill remaining peers from pool cache and start timer
  setInterval(function() { self.status(); }, 60*1000).unref(); // Send status message once a minute
};

PeerManager.prototype.openListener = function openListener() {
  this._error('Opening listening port...', 'info');

  var parentThis = this;
  var server = this.server = tls.createServer(settings.TLS_server_options, function(cleartextStream) {
    var p = new Peer(cleartextStream.remoteAddress, cleartextStream.remotePort, parentThis.options.magic);
    
    if (typeof parentThis.live[p.getUUID()] != 'undefined') {
      parentThis._error('Already connected to peer '+p.getUUID()+' yet they contacted us?', 'warning');
      return;
    }
    
    p.on('end', function(ev) {
      parentThis.emit('peerEnd', ev); // bubble up!
      if (ev.peer.state !== 'disconnecting') parentThis._disconnect(ev.peer); // Other end hung up on us; no need to hang around
    });
    p.on('error', function(ev) {
      parentThis.emit('peerError', ev); // bubble up!
      parentThis._warn(ev.peer, 10);
      if (ev.peer.state !== 'disconnecting') parentThis._disconnect(ev.peer); // Close the connection that errored
    });
    p.on('message', function(ev) {
      parentThis.emit('message', ev); // bubble up!
      parentThis.emit(ev.command+'Message', {
        peer: ev.peer,
        data: ev.data
      });
    });

    p.connect(cleartextStream); // Bind to existing socket
    parentThis.live[p.getUUID()] = p;
    parentThis.liveCount++;

    if (parentThis.state = 'initiating') {
      parentThis.state = 'running'; // First peer to connect updates state
    }
    parentThis.emit('listenConnect', { peer:p });
  });

  server.on('error', function (e) {
    if (e.code == 'EADDRINUSE') {
      parentThis._error('Can\'t open listening on port '+parentThis.options.port+'; port already in use', 'warning');
    }
  });
  server.listen(this.options.port, function() {
    parentThis._error('Now accepting connections on port '+parentThis.options.port, 'info');
  });
};

PeerManager.prototype._parseHost = function _parseHost(element) {
  var host, port, socket, cleartextStream;
  var target_proto = new tls.createSecurePair().cleartext.__proto__;
  if(!element){
    return false;
  } else if(typeof element == 'string') {
    var common = element.split(':')
    host = common[0].trim();
    port = common[1]? common[1].split('/')[0].trim() : this.options.port;
  } else if (Array.isArray(element)) {
    host = element[0];
    port = element[1] || this.options.port;
  } else if (element.host){
    host = element.host;
    port = element.port || this.options.port;
    socket = element.socket;
    cleartextStream = element.cleartextStream;
  } else if (element instanceof net.Socket){
    socket = element;
  } else if (element.__proto__ == target_proto){
    cleartextStream = element
  } else {
    return false;
  }

  // Check for bad peer
  var uuid = host+'~'+port;
  if (typeof this.badPeers[uuid] != 'undefined') {
    // Warning exists; check and see if it's expired
    if ((new Date().getTime() - this.badPeers[uuid].date)/1000/60 > this.badPeers[uuid].warning) {
      delete this.badPeers[uuid]; // Warning expired
    } else {
      return false; // Warning still active
    }
  }

  return {host:host, port:port, socket:socket, cleartextStream:cleartextStream};
};

function isLive(parsedHost){
  return this.live && this.live[parsedHost.host + '~' + parsedHost.port];
}

// Add a new peer to the pool.
// If the number of active peers is below the threshhold, connect to them immediately.
PeerManager.prototype.addPool = function addPool(hosts) {
  if (typeof hosts == 'string') {
    hosts = hosts.split('|');
  }
  var target = (this.state == 'initiating')? (this.options.targetPeers || (this.options.maxPeers + this.options.minPeers)/2) : this.options.minPeers;
  for (var i = 0; i < hosts.length; i++) {
    var rs = this._parseHost(hosts[i]);
    if (rs === false) continue;
    
    
    if (this.liveCount < target) {
      this.addLive(rs);
    } else {
      if (isLive(host)) continue;
      host.id = host.host + '~' + host.port;
      this.available.push(host);
    }
  }
  
  // De-duplicate available
  var unique = {};
  var distinct = [];
  this.available.forEach(function (peer) {
    if (!unique[peer.id]) {
      distinct.push(peer);
      unique[peer.id] = true;
    }
  });
  this.available = distinct;
  
  return true;
}

PeerManager.prototype.addLive = function addLive(hosts) {
  if (typeof hosts == 'string') {
    hosts = hosts.split('\n');
  } else if (!_.isArray(hosts)){
    hosts = [hosts]
  }
  for (var i = 0; i < hosts.length; i++) {
    var rs = this._parseHost(hosts[i]);
    if (rs === false) continue;
    if(isLive(rs)) continue;

    var p = this._connect(rs.host, rs.port);
    this.live[p.getUUID()] = p;
    this.liveCount++;
  }
}

// Internal function; don't call directly. Use addPool or addLive instead.
PeerManager.prototype._connect = function _connect(host, port) {
  port = port || this.options.port;
  var p = new Peer(host, port, this.options.magic);
  
  var parentThis = this;
  p.on('connect', function(d) {
    //console.log(d.peer.host.host+' resolved to '+d.peer.socket.remoteAddress+':'+d.peer.socket.remotePort);
    if (parentThis.state = 'initiating') {
      parentThis.state = 'running'; // First peer to connect updates state
    }
    parentThis.emit('peerConnect', d); // bubble up!
  });
  p.on('end', function(d) {
    parentThis.emit('peerEnd', d); // bubble up!
    if (d.peer.state !== 'disconnecting') parentThis._disconnect(d.peer); // Other end hung up on us; no need to hang around
  });
  p.on('error', function(d) {
    parentThis.emit('peerError', d); // bubble up!
    parentThis._warn(d.peer, 10);
    if (d.peer.state !== 'disconnecting') parentThis._disconnect(d.peer); // Close the connection that errored
  });
  p.on('message', function(d) {
    parentThis.emit('message', d); // bubble up!
    parentThis.emit(d.command+'Message', _.pluck(d.message, 'peer', 'data'));
  });

  setImmediate(function(parentThis) {
    parentThis._error('Attempting to connect to '+p.getUUID(), 'notice');
    p.connect();
    setTimeout(function() { // Give them a few seconds to respond, otherwise close the connection automatically
      if (p.state == 'connecting') {
        p.state = 'closed';
        parentThis._warn(p, 10);
        parentThis.kill(p, 'didn\'t respond to connection attempt; force-closing');
      }
    }, settings.TIMEOUT).unref();
  }, this);
  return p; // delay p.connect() using setImmediate, so that whatever is receiving this return value can prepare for the connection before it happens
};

// Periodic function that checks the status of the peer network being managed
PeerManager.prototype.checkPeers = function checkPeers() {
  if (this.state == 'shutdown') return;
  
  // First reset our own timer
  clearTimeout(this.fillTimeout); // If we were called early, reset the existing one
  this.fillTimeout = setTimeout(function() { self.checkPeers(); }, settings.checkInterval);
  this.fillTimeout.unref(); // If this timer is the only thing going, don't keep program open just for it
  
  // Timeout peers that have been quiet for too long
  for (var uuid in this.live) {
    if (this.live.hasOwnProperty(uuid) && this.live[uuid].lastSeen !== false && this.live[uuid].lastSeen.getTime() < new Date().getTime() - this.options.idleTimeout) {
      this._error(uuid+' has been quiet too long; disconnecting', 'info');
      this._disconnect(this.live[uuid]);
    }
  }
  
  // Ensure minimum number of active peers are set
  if (this.liveCount < this.options.minPeers) {
    this._error('Too few active peers ('+this.liveCount+' < '+this.options.minPeers+'); pulling more from pool', 'info');
    while (this.liveCount < this.options.minPeers) {
      if (this.available.length == 0) {
        this._error('No more pooled peers...', 'info');
        return;
      }
    
      var peer = this.available.shift();
      this.addLive([peer]); // Synchronously queues up a Peer to be connected, and increments liveCount, so this while loop works
    }
  }
  
  // Warn if more than maximum is set
  if (this.liveCount > this.options.maxPeers) {
    this._error('Number of active peers above the maximum ('+this.liveCount+' > '+this.options.maxPeers+'); find a way to determine which should be disconnected, and call kill() on them.');
  }
};

PeerManager.prototype.status = function status() {
  this.emit('status', {
    'numActive': this.liveCount,
    'poolSize': this.available.length,
    'badPeers': this.badPeers
  });
};

PeerManager.prototype.send = function send(number, property, values, cmd, payload, answer, callback) {
  if (number == false || number < 0) number = 'all';
  if (!Array.isArray(values)) values = [values];
  if (typeof payload == 'undefined') payload = new Buffer(0);

  // Build a sub-set of items
  var uuids = [];
  for (var uuid in this.live) {
    //look if value is contained in values
    if(this.live[uuid] && values.indexOf(this.live[uuid][property]) != -1){
      uuids.push(uuid);
    }
  }
  if (uuids.length == 0) return false; // None matched that filter
  
  // Shuffle
  var i = uuids.length, randomIndex, temp;
  while (0 !== i) {
    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * i);
    i--;

    // And swap it with the current element.
    temp = uuids[i];
    uuids[i] = uuids[randomIndex];
    uuids[randomIndex] = temp;
  }
  
  var recipients = [];
  if (number == 'all') number = uuids.length;
  while (recipients.length < number && uuids.length > 0) {
    var uuid = uuids.pop();
    var p = this.live[uuid];
    if (typeof p !== 'undefined') { // Ensure it hasn't closed in the gap
      recipients.push(p);
    }
  }
  
  // now send to recipients:
  var ret = {};
  for(var i=0; i<recipients.length; i++){
    ret[recipients[i].getUUID()] = recipients[i];
    recipients[i].send(cmd, payload);
    if(typeof callback == 'function'){
        recipients[i].on(answer, callback);
    }
  }

  return ret; 
};

PeerManager.prototype.kill = function kill(p, reason) {
  if (typeof this.live[p.getUUID()] == 'undefined') return; // We weren't connected to them in the first place
  if(['disconnectiong', 'disconnected', 'closed'].indexOf(p.state) == -1){
    if (typeof reason == 'string') {
      this._error('Disconnecting from '+p.getUUID()+' ('+p.state+'); '+reason, 'info');
    } else {
      this._error('Disconnecting from '+p.getUUID()+' ('+p.state+')', 'info');
    }
    return this._disconnect(p); // Hang up first, then delete
  }
  
  p.destroy();
  delete this.live[p.getUUID()];
  this.liveCount--;
  if (typeof reason == 'string') {
    this._error(p.getUUID()+' closed; '+reason+'. '+this.liveCount+' active peers now', 'info');
  } else {
    this._error(p.getUUID()+' closed; '+this.liveCount+' active peers now', 'info');
  }
  
  if (this.state == 'shutdown') return; // Don't attempt to add more peers if in shutdown mode
  var parentThis = this;
  setImmediate(function() { parentThis.checkPeers(); });
};

PeerManager.prototype._warn = function _warn(p, mins) {
  var uuid = p.getUUID();
  if (typeof this.badPeers[uuid] != 'undefined') {
    // Already has a warning; see if it's expired
    var warningRemaining = this.badPeers[uuid].warning - ((new Date().getTime() - this.badPeers[p.getUUID()].date)/1000/60); //We warn in minutes!
    if (warningRemaining < 0) warningRemaining = 0;
    // Add new warning to the old
    this.badPeers[uuid].warning = warningRemaining + mins;
    this.badPeers[uuid].date = new Date().getTime();
  } else {
    this.badPeers[uuid] = {
      host: p.host.host,
      port: p.host.port,
      date: new Date().getTime(),
      warning: mins
    };
  }
};

// Internal function; don't call directly. Use kill instead.
PeerManager.prototype._disconnect = function _disconnect(p) {
  p.state = 'disconnecting';
  var parentThis = this;
  p.once('close', function(d) {
    parentThis.kill(d.peer, 'remote connection closed');
  });
  p.disconnect();
  // Give them a few seconds to close out, otherwise we'll just delete
  setTimeout(function() {
    if (parentThis.live[p.getUUID()] == p) {
      // Hasn't been deleted yet
      parentThis._error(p.getUUID()+' didn\'t close on their own; force-closing', 'notice');
      p.destroy(); // Triggers a 'close' event, so the above listener will fire
    }
  }, settings.TIMEOUT).unref();
};

PeerManager.prototype.shutdown = function shutdown() {
  this.state = 'shutdown';
  if (this.server !== false) {
    this.server.close();
  }
  for (var uuid in this.live) {
    if (this.live[uuid] instanceof Peer) {
      this._error('Disconnecting '+uuid, 'notice');
      this._disconnect(this.live[uuid]);
    }
  }
};

// Trigger an error message. Severity is one of 'info', 'notice', 'warning', or 'error' (in increasing severity)
PeerManager.prototype._error = function _error(message, severity) {
  severity = severity || 'warning';
  this.emit('error', {
    severity: severity,
    message: message
  });
};