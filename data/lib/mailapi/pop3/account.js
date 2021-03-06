define(['rdcommon/log', '../errbackoff', '../composite/incoming', './sync',
        './jobs', '../drafts/draft_rep', 'module', 'require', 'exports'],
function(log, errbackoff, incoming, pop3sync,
         pop3jobs, draftRep, module, require, exports) {
var CompositeIncomingAccount = incoming.CompositeIncomingAccount;

/**
 * Define a POP3 account. Much of the functionality here is similar
 * to IMAP; Pop3Account inherits the shared parts from
 * CompositeIncomingAccount.
 */
function Pop3Account(universe, compositeAccount, accountId, credentials,
                     connInfo, folderInfos, dbConn, _parentLog,
                     existingProtoConn) {
  this._LOG = LOGFAB.Pop3Account(this, _parentLog, accountId);
  CompositeIncomingAccount.apply(
      this, [pop3sync.Pop3FolderSyncer].concat(Array.slice(arguments)));

  // Set up connection information. We can't make much use of
  // connection pooling since the POP3 protocol only allows one client
  // to access a mailbox at a given time, so there's no connection pool.
  this._conn = null;
  this._pendingConnectionRequests = [];
  this._backoffEndpoint =
      errbackoff.createEndpoint('pop3:' + this.id, this, this._LOG);
  this.tzOffset = 0; // POP3 has no concept of time zones.

  // If we have an existing connection from setting up the account, we
  // can reuse that during the first sync.
  if (existingProtoConn) {
    this._conn = existingProtoConn;
  }

  // Create required folders if necessary.
  ['sent', 'localdrafts', 'trash'].forEach(function(name) {
    var folder = this.getFirstFolderWithType(name);
    if (!folder) {
      this._learnAboutFolder(name, name, null, name, '/', 0, true);
    }
  }.bind(this));

  this._jobDriver = new pop3jobs.Pop3JobDriver(
      this, this._folderInfos.$mutationState, this._LOG);
}
exports.Account = exports.Pop3Account = Pop3Account;
Pop3Account.prototype = Object.create(CompositeIncomingAccount.prototype);
var properties = {
  type: 'pop3',
  supportsServerFolders: false,
  toString: function() {
    return '[Pop3Account: ' + this.id + ']';
  },

  /**
   * Call the callback with a live, authenticated connection. Clients
   * should call done() when finished with the connection. (In our
   * case, pop3/sync.js has a lazyWithConnection wrapper which
   * abstracts the `done` callback.)
   * @param {function(err, conn, done)} cb
   */
  withConnection: function(cb, whyLabel) {
    // This implementation serializes withConnection requests so that
    // we don't step on requests' toes. While Pop3Client wouldn't mix
    // up the requests themselves, interleaving different operations
    // could result in undesired consequences.
    this._pendingConnectionRequests.push(cb);
    var done = function() {
      var req = this._pendingConnectionRequests.shift();
      if (req) {
        var next = function(err) {
          if (err) {
            req(err);
            done();
          } else {
            req(null, this._conn, done);
          }
        }.bind(this);
        if (!this._conn || this._conn.state === 'disconnected') {
          this._makeConnection(next, whyLabel);
        } else {
          next();
        }
      }
    }.bind(this);

    if (this._pendingConnectionRequests.length === 1) {
      done();
    }
  },

  /** @override */
  __folderDoneWithConnection: function(conn) {
    // IMAP uses this function to perform folder-specific connection cleanup.
    // We don't need to do anything here.
  },

  /**
   * Create a new POP3 connection, and call the callback when we
   * have established the connection (or with an error if we failed).
   * Since POP3 only uses one connection at a time, this function also
   * assigns the given connection to this._conn.
   *
   * Don't use this function directly; instead use `withConnection` or
   * a higher-level wrapper.
   *
   * @param {function(err, conn)} callback
   * @param {String} whyLabel A descriptive name for the connection.
   */
  _makeConnection: function(callback, whyLabel) {
    // Mark a pending connection synchronously; the require call will
    // not return until at least the next turn of the event loop, so
    // we need to know that there's a pending connection request in
    // progress.
    this._conn = true;
    // Dynamically load the probe/pop3 code to speed up startup.
    require(['pop3/pop3', './probe'], function(pop3, pop3probe) {
      this._LOG.createConnection(whyLabel);
      var opts = {
        host: this._connInfo.hostname,
        port: this._connInfo.port,
        crypto: this._connInfo.crypto,

        preferredAuthMethod: this._connInfo.preferredAuthMethod,

        username: this._credentials.username,
        password: this._credentials.password,
      };
      if (this._LOG) opts._logParent = this._LOG;
      var conn = this._conn = new pop3.Pop3Client(opts, function(err) {
        if (err) {
          // Failed to get the connection:
          console.error('Connect error:', err.name, 'formal:', err, 'on',
                        this._connInfo.hostname, this._connInfo.port);

          err = pop3probe.analyzeError(err);

          if (err.reportProblem) {
            this.universe.__reportAccountProblem(
              this.compositeAccount, err.name, 'incoming');
          }

          callback && callback(err.name, null);
          conn.die();

          // track this failure for backoff purposes
          if (err.retry &&
              this._backoffEndpoint.noteConnectFailureMaybeRetry(
                err.reachable)) {
            this._backoffEndpoint.scheduleConnectAttempt(
              this._makeConnection.bind(this));
          } else {
            this._backoffEndpoint.noteBrokenConnection();
          }
          return;
        }
        // Succeeded:
        this._backoffEndpoint.noteConnectSuccess();
        callback && callback(null, conn);
      }.bind(this));
    }.bind(this));
  },

  /**
   * Save an attachment-stripped version of the sent draft to our sent folder.
   */
  saveSentMessage: function(composer) {
    var sentFolder = this.getFirstFolderWithType('sent');
    if (!sentFolder) {
      return;
    }

    var sentStorage = this.getFolderStorageForFolderId(sentFolder.id);
    var id = sentStorage._issueNewHeaderId();
    var suid = sentStorage.folderId + '/' + id;

    var sentPieces = draftRep.cloneDraftMessageForSentFolderWithoutAttachments(
      composer.header, composer.body, { id: id, suid: suid });

    this.universe.saveSentDraft(sentFolder.id,
                                sentPieces.header, sentPieces.body);
  },

  /**
   * Delete the given folder. (This always happens locally.)
   */
  deleteFolder: function(folderId, callback) {
    if (!this._folderInfos.hasOwnProperty(folderId)) {
      throw new Error("No such folder: " + folderId);
    }
    var folderMeta = this._folderInfos[folderId].$meta;
    self._LOG.deleteFolder(folderMeta.path);
    self._forgetFolder(folderId);
    callback && callback(null, folderMeta);
  },

  /**
   * Shut down the account and close the connection.
   */
  shutdown: function(callback) {
    CompositeIncomingAccount.prototype.shutdownFolders.call(this);

    this._backoffEndpoint.shutdown();

    if (this._conn && this._conn.die) {
      this._conn.die();
    }
    this._LOG.__die();
    callback && callback();
  },

  /**
   * Attempt to create a new, authenticated connection using the
   * current credentials. If a current connection is already
   * established, terminates the existing connection first.
   *
   * @param {function(err)} callback
   */
  checkAccount: function(callback) {
    // Disconnect first so as to properly check credentials.
    if (this._conn != null) {
      if (this._conn.state !== 'disconnected') {
        this._conn.disconnect();
      }
      this._conn = null;
    }
    this._LOG.checkAccount_begin(null);
    this.withConnection(function(err) {
      this._LOG.checkAccount_end(err);
      callback(err);
    }.bind(this), 'checkAccount');
  },

  /**
   * Destroy the account when the account has been deleted.
   */
  accountDeleted: function() {
    this._alive = false;
    this.shutdown();
  },

};

// Inherit Pop3Account from CompositeIncomingAccount:
// XXX: Use mix.js when it lands in the streaming patch.
for (var k in properties) {
  Object.defineProperty(Pop3Account.prototype, k,
                        Object.getOwnPropertyDescriptor(properties, k));
}

// Share the log configuration with CompositeIncomingAccount, since we
// desire general parity between IMAP and POP3 for simplicity.
var LOGFAB = exports.LOGFAB = log.register(module, {
  Pop3Account: incoming.LOGFAB_DEFINITION.CompositeIncomingAccount
});


}); // end define
