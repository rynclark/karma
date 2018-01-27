var SocketIO = require('socket.io')
var di = require('di')
var util = require('util')
var Promise = require('bluebird')
var spawn = require('child_process').spawn
var tmp = require('tmp')
var fs = require('fs')
var path = require('path')
var root = global || window || this

var cfg = require('./config')
var logger = require('./logger')
var constant = require('./constants')
var watcher = require('./watcher')
var plugin = require('./plugin')

var ws = require('./web-server')
var preprocessor = require('./preprocessor')
var Launcher = require('./launcher').Launcher
var FileList = require('./file-list')
var reporter = require('./reporter')
var helper = require('./helper')
var events = require('./events')
var EventEmitter = events.EventEmitter
var Executor = require('./executor')
var Browser = require('./browser')
var BrowserCollection = require('./browser_collection')
var EmitterWrapper = require('./emitter_wrapper')
var processWrapper = new EmitterWrapper(process)
var browserify = require('browserify')

const karmaJsPath = path.join(__dirname, '/../static/karma.js')
const contextJsPath = path.join(__dirname, '/../static/context.js')

/**
 * Bundles a static resource using Browserify.
 * @param {string} inPath the path to the file to browserify
 * @param {string} outPath the path to output the bundle to
 * @returns {Promise}
 */
function bundleResource (inPath, outPath) {
  return new Promise((resolve, reject) => {
    var bundler = browserify(inPath)
    bundler.bundle().pipe(fs.createWriteStream(outPath))
      .once('finish', () => {
        resolve()
      })
      .once('error', (e) => {
        reject(e)
      })
  })
}

function createSocketIoServer (webServer, executor, config) {
  var server = new SocketIO(webServer, {
    // avoid destroying http upgrades from socket.io to get proxied websockets working
    destroyUpgrade: false,
    path: config.urlRoot + 'socket.io/',
    transports: config.transports,
    forceJSONP: config.forceJSONP
  })

  // hack to overcome circular dependency
  executor.socketIoSockets = server.sockets

  return server
}

// Constructor
var Server = function (cliOptions, done) {

  EventEmitter.call(this)

  logger.setupFromConfig(cliOptions)

  this.log = logger.create()

  this.loadErrors = []

  var config = cfg.parseConfig(cliOptions.configFile, cliOptions)

  var modules = [{
    helper: ['value', helper],
    logger: ['value', logger],
    done: ['value', done || process.exit],
    emitter: ['value', this],
    server: ['value', this],
    launcher: ['type', Launcher],
    config: ['value', config],
    preprocess: ['factory', preprocessor.createPreprocessor],
    fileList: ['type', FileList],
    webServer: ['factory', ws.create],
    socketServer: ['factory', createSocketIoServer],
    executor: ['type', Executor],
    // TODO(vojta): remove
    customFileHandlers: ['value', []],
    // TODO(vojta): remove, once karma-dart does not rely on it
    customScriptTypes: ['value', []],
    reporter: ['factory', reporter.createReporters],
    capturedBrowsers: ['type', BrowserCollection],
    args: ['value', {}],
    timer: ['value', {
      setTimeout: function () {
        return setTimeout.apply(root, arguments)
      },
      clearTimeout: function (timeoutId) {
        clearTimeout(timeoutId)
      }
    }]
  }]

  this._setUpLoadErrorListener()
  // Load the plugins
  modules = modules.concat(plugin.resolve(config.plugins, this))

  this._injector = new di.Injector(modules)
}

// Inherit from events.EventEmitter
util.inherits(Server, EventEmitter)

// Public Methods
// --------------

// Start the server
Server.prototype.start = function () {
  return this._injector.invoke(this._start, this);
}

Server.prototype.init = function () {
  return this._injector.invoke(this._init, this);
}

/**
 * Backward-compatibility with karma-intellij bundled with WebStorm.
 * Deprecated since version 0.13, to be removed in 0.14
 */
Server.start = function (cliOptions, done) {
  var server = new Server(cliOptions, done)
  server.start()
}

// Get properties from the injector
//
// token - String
Server.prototype.get = function (token) {
  return this._injector.get(token)
}

// Force a refresh of the file list
Server.prototype.refreshFiles = function () {
  if (!this._fileList) return Promise.resolve()

  return this._fileList.refresh()
}

// Private Methods
// ---------------

Server.prototype.launch = function () {

};

Server.prototype._start = function (config) {
  return new Promise((resolve, reject) => {
    const config = this._injector.get('config');
    const webServer = this._injector.get('webServer');

    webServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        this.log.warn('Port %d in use', config.port)
        config.port++
        webServer.listen(config.port, config.listenAddress)
      } else {
        throw e
      }
    });

    webServer.listen(config.port, config.listenAddress, () => {
      this.log.info('Karma v%s server started at %s//%s:%s%s', constant.VERSION,
        config.protocol, config.listenAddress, config.port, config.urlRoot)

      this.emit('listening', config.port)
      if (config.browsers && config.browsers.length) {
        resolve();
        // this._injector.invoke(launcher.launch, launcher).forEach(function (browserLauncher) {
        //   singleRunDoneBrowsers[browserLauncher.id] = false
        // })
      }
      const noLoadErrors = this.loadErrors.length;
      if (noLoadErrors > 0) {
        this.log.error('Found %d load error%s', noLoadErrors, noLoadErrors === 1 ? '' : 's')
        process.exitCode = 1
        process.kill(process.pid, 'SIGINT')
      }
    });
  });
};

Server.prototype._init = function (config, launcher, preprocess, fileList,
                                    capturedBrowsers, executor, done) {

  var self = this
  if (config.detached) {
    this._detach(config, done)
    return
  }

  self._fileList = fileList

  config.frameworks.forEach(function (framework) {
    self._injector.get('framework:' + framework)
  })

  var socketServer = self._injector.get('socketServer')

  // A map of launched browsers.
  var singleRunDoneBrowsers = Object.create(null)

  // Passing fake event emitter, so that it does not emit on the global,
  // we don't care about these changes.
  var singleRunBrowsers = new BrowserCollection(new EventEmitter())

  // Some browsers did not get captured.
  var singleRunBrowserNotCaptured = false

  var afterPreprocess = function () {
    console.log('l');
    if (config.autoWatch) {
      self._injector.invoke(watcher.watch)
    }

    // Check if the static files haven't been compiled
    if (!(fs.existsSync(karmaJsPath) && fs.existsSync(contextJsPath))) {
      self.log.info('Front-end scripts not present. Compiling...')
      var mainPromise = bundleResource(path.join(__dirname, '/../client/main.js'), karmaJsPath)
      var contextPromise = bundleResource(path.join(__dirname, '/../context/main.js'), contextJsPath)
      Promise.all([mainPromise, contextPromise]).then(() => {
        startWebServer()
      }).catch((error) => {
        self.log.error('Front-end script compile failed with error: ' + error)
        process.exitCode = 1
        process.kill(process.pid, 'SIGINT')
      })
    } else {
      startWebServer()
    }
  }

  return fileList.refresh();
}

Server.prototype._setUpLoadErrorListener = function () {
  var self = this
  self.on('load_error', function (type, name) {
    self.log.debug('Registered a load error of type %s with name %s', type, name)
    self.loadErrors.push([type, name])
  })
}

Server.prototype._detach = function (config, done) {
  var log = this.log
  var tmpFile = tmp.fileSync({keep: true})
  log.info('Starting karma detached')
  log.info('Run "karma stop" to stop the server.')
  log.debug('Writing config to tmp-file %s', tmpFile.name)
  config.detached = false
  try {
    fs.writeFileSync(tmpFile.name, JSON.stringify(config), 'utf8')
  } catch (e) {
    log.error("Couldn't write temporary configuration file")
    done(1)
    return
  }
  var child = spawn(process.argv[0], [path.resolve(__dirname, '../lib/detached.js'), tmpFile.name], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

// Export
// ------

module.exports = Server
