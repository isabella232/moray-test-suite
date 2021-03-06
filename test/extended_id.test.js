/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var crypto = require('crypto');
var tape = require('tape');
var vasync = require('vasync');

var helper = require('./helper.js');


var BUCKET_CFG = {
    index: {
        str: {
            type: 'string'
        },
        str_u: {
            type: 'string',
            unique: true
        },
        bool: {
            type: 'boolean'
        }
    },
    options: {
        version: 1
    }
};


function test(name, setup) {
    var server;
    var client;
    var bucket_name = 'moray_test_extended_id_' +
        crypto.randomBytes(4).toString('hex').toLowerCase();
    var ready = false;

    tape.test(name + ' - setup', function (t) {
        helper.createServer(null, function (s) {
            server = s;
            client = helper.createClient();
            client.on('connect', function () {
                client.createBucket(bucket_name, BUCKET_CFG, function (err) {
                    t.ifError(err);
                    ready = true;
                    t.end();
                });
            });
        });
    });

    tape.test(name + ' - main', function (t) {
        t.ok(ready, 'bucket must be ready');
        setup(t, client, bucket_name);
    });

    tape.test(name + ' - teardown', function (t) {
        client.delBucket(bucket_name, function (err) {
            t.ifError(err);
            client.once('close', function () {
                helper.cleanupServer(server, function () {
                    t.pass('closed');
                    t.end();
                });
            });
            client.close();
        });
    });
}

function rando(n) {
    return (crypto.randomBytes(n).toString('hex').toUpperCase());
}

function makeObject() {
    var o = {
        str: 'string value ' + rando(8),
        str_u: 'unique string value ' + rando(8),
        bool: false
    };

    return (o);
}

function runSQL(c, sql, args, done) {
    if (Array.isArray(sql)) {
        sql = sql.join(' ');
    }

    var res = c.sql(sql, args);

    res.on('error', function (err) {
        done(err);
    });

    var rows = [];
    res.on('record', function (row) {
        rows.push(row);
    });

    res.on('end', function () {
        done(null, rows);
    });
}

function findAll(c, bucket_name, filter, opts, done) {
    if (typeof (opts) === 'function') {
        done = opts;
        opts = {};
    }

    var res = c.findObjects(bucket_name, filter, opts);

    var rows = [];
    res.on('record', function (row) {
        rows.push({ o_id: row._id, o_key: row.key });
    });

    res.on('error', function (err) {
        done(err);
    });

    res.on('end', function () {
        if (!opts.sort) {
            /*
             * If no sort order was provided, ensure the results are sorted
             * by _id for comparison with the expected result set.
             */
            rows.sort(function (a, b) {
                return (a.o_id - b.o_id);
            });
        }
        done(null, rows);
    });
}


/*
 * TESTS
 */

/*
 * All new buckets will be created with a BIGINT "_id" column.
 */
test('confirm bigint for new "_id" columns', function (t, c, b) {
    var sql = [
        'SELECT',
        '    column_name,',
        '    data_type,',
        '    numeric_precision',
        'FROM',
        '    information_schema.columns isc',
        'WHERE',
        '    isc.table_name = $1 AND',
        '    isc.column_name = $2'
    ];

    var res = c.sql(sql.join(' '), [ b, '_id' ]);

    var rows = [];
    res.on('record', function (_row) {
        rows.push(_row);
    });

    res.on('error', function (err) {
        t.ifError(err, 'verifying "_id" column type');
        t.end();
    });

    res.on('end', function () {
        t.equal(rows.length, 1, 'expect one result row');
        t.deepEqual(rows[0], {
            column_name: '_id',
            data_type: 'bigint',
            numeric_precision: 64
        });
        t.end();
    });
});

test('composite "_id" property ("_id" and "_idx" columns)', function (t, c, b) {
    /*
     * The largest possible value we can store in an INTEGER (32-bit) column in
     * PostgreSQL.
     */
    var max32 = 2147483647;

    /*
     * The largest possible integer we can represent without loss of precision
     * in Javascript (2^53 - 1).
     */
    var max53 = 9007199254740991;

    /*
     * Keep track of all of the keys we have added to the bucket.  Each entry
     * in this array has "o_key" and "o_id".  Objects before the type change
     * are in "objects"; objects after the type change are in "extObjects".
     */
    var objects = [];
    var extObjects = [];

    /*
     * We want to create this many objects before and after the change from
     * "_id" to "_idx".
     */
    var desired = 37;

    /*
     * To test some of the error handling, we'll use SQL statements to force an
     * object into the database with an unrepresentably large "_id" value.
     */
    var impossibleId = max53 * 4;
    var bigKey;

    vasync.waterfall([ function (next) {
        /*
         * New buckets are created with a BIGINT "_id" column, but older
         * buckets may have been created with an INTEGER (32-bit) "_id" column.
         * Before we put any objects into the test bucket, force its data type
         * back to the original 32-bit size.
         */
        runSQL(c, [
            'ALTER TABLE "' + b + '"',
            'ALTER COLUMN "_id"',
            'TYPE INTEGER'
        ], [], function (err, rows) {
            t.ifError(err, 'alter table');
            next(err);
        });

    }, function (next) {
        /*
         * Confirm that the type and precision are as expected.
         */
        runSQL(c, [
            'SELECT',
            '    column_name,',
            '    data_type,',
            '    numeric_precision',
            'FROM',
            '    information_schema.columns isc',
            'WHERE',
            '    isc.table_name = $1 AND',
            '    isc.column_name = $2'
        ], [ b, '_id' ], function (err, rows) {
            if (err) {
                t.ifError(err, 'verifying "_id" column type');
                next(err);
                return;
            }

            t.equal(rows.length, 1, 'expect one result row');
            t.deepEqual(rows[0], {
                column_name: '_id',
                data_type: 'integer',
                numeric_precision: 32
            });
            next();
        });

    }, function (next) {
        /*
         * Adjust the sequence used to generate new "_id" values so that there
         * are only two more valid IDs in the original 32-bit space.
         */
        runSQL(c, [
            'ALTER SEQUENCE "' + b + '_serial"',
            'RESTART WITH ' + (max32 - desired + 1)
        ], [], function (err, rows) {
            t.ifError(err, 'alter sequence');
            next(err);
        });

    }, function (next) {
        /*
         * Put the desired number of objects into the bucket to exhaust the
         * remainder of the 32-bit id space.
         */
        (function putOne() {
            if (objects.length >= desired) {
                t.ok(true, 'successfully put ' + desired + ' 32-bit objects');
                next();
                return;
            }

            var key = rando(8);
            var num = objects.length + 1;
            var expectedId = max32 - desired + num;
            c.putObject(b, key, makeObject(), function (err) {
                if (err) {
                    t.ifError(err, 'put object ' + num + ' should succeed');
                    next(err);
                    return;
                }

                /*
                 * Confirm that the ID value is as we expect.
                 */
                c.getObject(b, key, function (er_, res) {
                    if (er_) {
                        t.ifError(er_, 'get object ' + num + ' should succeed');
                        next(er_);
                        return;
                    }

                    objects.push({ o_id: res._id, o_key: key });

                    t.ok(res, 'have object ' + num);
                    t.strictEqual(res._id, expectedId,
                      'object ' + num + ' has id ' + expectedId);

                    setImmediate(putOne);
                });
            });
        })();

    }, function (next) {
        /*
         * We should not be able to create another object as the next value in
         * the sequence is 2147483648, which does not fit in the 32-bit ID
         * column.
         *
         * NOTE: Though the value will not fit in the column, it will
         * nonetheless be consumed from the sequence.  The next object will
         * get the ID 2147483649.
         */
        c.putObject(b, rando(8), makeObject(), function (err) {
            t.ok(err instanceof Error, 'final 32-bit put object should fail');
            next(err ? null : new Error('expected error'));
        });

    }, function (next) {
        /*
         * Create the extended ID ("_idx") column in the bucket.
         */
        runSQL(c, [
            'ALTER TABLE "' + b + '"',
            'ADD COLUMN _idx BIGINT'
        ], [], function (err, rows) {
            t.ifError(err, 'add column _idx');
            next(err);
        });

    }, function (next) {
        /*
         * Add the expected index on the "_idx" column.
         */
        runSQL(c, [
            'CREATE INDEX "' + b + '__idx_idx" ON "' + b + '"',
            'USING BTREE (_idx) WHERE _idx IS NOT NULL'
        ], [], function (err, rows) {
            t.ifError(err, 'create _idx index');
            next(err);
        });

    }, function (next) {
        /*
         * Move the DEFAULT from the "_id" column to the new and wider "_idx"
         * column so that the sequence can begin assigning values larger than
         * 2147483647.
         */
        runSQL(c, [
            'ALTER TABLE "' + b + '"',
            'ALTER COLUMN _id DROP DEFAULT,',
            'ALTER COLUMN _idx SET DEFAULT',
            'nextval(\'' + b + '_serial\'::regclass)'
        ], [], function (err, rows) {
            t.ifError(err, 'reconfigure default value');
            next(err);
        });

    }, function (next) {
        /*
         * Perform a get of the first object we put, using the option to bypass
         * the bucket cache.  This should force the Moray server to detect the
         * new "_idx" column without waiting 300 seconds for the bucket cache
         * entry to expire and reload.
         */
        var o = objects[0];
        c.getObject(b, o.o_key, { noBucketCache: true },
          function (err, res) {
            if (err) {
                t.ifError(err, 'get first object to flush cache');
                next(err);
                return;
            }

            t.ok(res);
            t.strictEqual(res._id, o.o_id, 'first object _id ok');
            next();
        });

    }, function (next) {
        /*
         * Put the desired number of objects into the bucket now that we are
         * using the enlarged 64-bit id space.
         */
        var putOne = function () {
            if (extObjects.length >= desired) {
                t.ok(true, 'successfully put ' + desired + ' 64-bit objects');
                next();
                return;
            }

            var key = rando(8);
            var num = extObjects.length + 1;
            var expectedId = max32 + 1 + num;
            c.putObject(b, key, makeObject(), function (err) {
                if (err) {
                    t.ifError(err, 'put object ' + num + ' should succeed');
                    next(err);
                    return;
                }

                /*
                 * Confirm that the ID value is as we expect.
                 */
                c.getObject(b, key, function (er_, res) {
                    if (er_) {
                        t.ifError(er_, 'get object ' + num + ' should succeed');
                        next(er_);
                        return;
                    }

                    extObjects.push({ o_id: res._id, o_key: key });

                    t.ok(res, 'have object ' + num);
                    t.strictEqual(res._id, expectedId,
                      'object ' + num + ' has id ' + expectedId);

                    setImmediate(putOne);
                });
            });
        };

        putOne();

    }, function (next) {
        /*
         * Request all of the objects we have created so far, using a column
         * other than "_id".
         */
        findAll(c, b, '(str=*)', function (err, rows) {
            if (err) {
                t.ifError(err, 'failed to find (str=*)');
                next(err);
                return;
            }

            /*
             * We expect to see everything we created.
             */
            var expected = objects.concat(extObjects);

            t.deepEqual(rows, expected, 'found all objects by (str=*)');
            next();
        });

    }, function (next) {
        /*
         * Request all of the objects we have created so far, using the "_id"
         * column.
         */
        findAll(c, b, '(_id>=0)', function (err, rows) {
            if (err) {
                t.ifError(err, 'failed to find (_id>=0)');
                next(err);
                return;
            }

            /*
             * We expect to see everything we created.
             */
            var expected = objects.concat(extObjects);

            t.deepEqual(rows, expected, 'found all objects by (_id>=0)');
            next();
        });

    }, function (next) {
        /*
         * Request all objects we have created so far, using a sort on "_id".
         */
        findAll(c, b, '(_id>=0)', { sort: { order: 'ASC', attribute: '_id' }},
          function (err, rows) {
            if (err) {
                t.ifError(err, 'failed to find (_id>=0) [sort: _id ASC]');
                next(err);
                return;
            }

            /*
             * We expect to see everything we created.  As _id values are
             * assigned in ascending order, the result set should match the
             * order of object creation.
             */
            var expected = objects.concat(extObjects);

            t.deepEqual(rows, expected, 'objects sorted by _id ASC');
            next();
        });

    }, function (next) {
        /*
         * Request all objects we have created so far, using a sort on "_id".
         */
        findAll(c, b, '(_id>=0)', { sort: { order: 'DESC', attribute: '_id' }},
          function (err, rows) {
            if (err) {
                t.ifError(err, 'failed to find (_id>=0) [sort: _id DESC]');
                next(err);
                return;
            }

            /*
             * We expect to see everything we created.  As _id values are
             * assigned in ascending order, this descending sort result set
             * should match the _reverse_ of object creation order.
             */
            var expected = objects.concat(extObjects).reverse();

            t.deepEqual(rows, expected, 'objects sorted by _id DESC');
            next();
        });

    }, function (next) {
        /*
         * Request all of the objects with 32-bit IDs and one with a 64-bit
         * ID.
         */
        var f = '(_id<=' + (max32 + 2) + ')';
        findAll(c, b, f, function (err, rows) {
            if (err) {
                t.ifError(err, 'failed to find ' + f);
                next(err);
                return;
            }

            var expected = objects.concat([ extObjects[0] ]);

            t.deepEqual(rows, expected, 'found expected objects by ' + f);
            next();
        });

    }, function (next) {
        /*
         * Request two of the objects with a 32-bit ID and all of those with
         * 64-bit IDs.
         */
        var f = '(_id>=' + (max32 - 1) + ')';
        findAll(c, b, f, function (err, rows) {
            if (err) {
                t.ifError(err, 'failed to find ' + f);
                next(err);
                return;
            }

            var expected = [ objects[objects.length - 2],
                objects[objects.length - 1] ].concat(extObjects);

            t.deepEqual(rows, expected, 'found expected objects by ' + f);
            next();
        });

    }, function (next) {
        /*
         * Use the bulk update functionality to set "bool" to true on some
         * set of objects that straddles the divide.
         */
        var f = '(|(_id=' + objects[0].o_id + ')(_id>=' + (max32 - 1) + '))';
        c.updateObjects(b, { bool: true }, f, {}, function (err, res) {
            if (err) {
                t.ifError(err, 'failed to update bool on ' + f);
                next(err);
                return;
            }

            t.equal(res.count, 1 + 2 + desired,
              'updated expected count of objects');

            findAll(c, b, '(bool=true)', function (er_, rows) {
                if (er_) {
                    t.ifError(er_, 'failed to find updated objects');
                    next(er_);
                    return;
                }

                var expected = [ objects[0], objects[objects.length - 2],
                    objects[objects.length - 1] ].concat(extObjects);

                t.deepEqual(rows, expected, 'found objects updated by ' + f);
                next();
            });
        });

    }, function (next) {
        /*
         * Use the bulk delete functionality to try to remove the first two and
         * last two objects we created, but only if "bool" is set to false.
         * This should result in only the second object being removed, as
         * "bool" was set to true on all others in the previous test step.
         */
        var f = [
            '(&(bool=false)(|',
            '(_id=' + objects[0].o_id + ')',
            '(_id=' + objects[1].o_id + ')', /* only this one will be deleted */
            '(_id=' + extObjects[extObjects.length - 2].o_id + ')',
            '(_id=' + extObjects[extObjects.length - 1].o_id + ')',
            '))'
        ].join('');
        c.deleteMany(b, f, function (err, res) {
            if (err) {
                t.ifError(err, 'failed to delete on ' + f);
                next(err);
                return;
            }

            t.ok(true, 'delete on ' + f);
            t.equal(res.count, 1, 'deleted expected count of objects');

            /*
             * We expect to see everything we created except for the first
             * object.
             */
            findAll(c, b, '(_id>=0)', function (er_, rows) {
                if (er_) {
                    t.ifError(er_, 'failed to find (_id>=0) after delete');
                    next(er_);
                    return;
                }

                /*
                 * We expect to see everything except for the second object we
                 * created.
                 */
                var expected = objects.slice(0, 1).concat(objects.slice(2)).
                  concat(extObjects);

                t.deepEqual(rows, expected, 'found by (_id>=0) after delete');
                next();
            });
        });

    }, function (next) {
        /*
         * Use the batch functionality to remove some more objects and update
         * the "bool" property on the rest to be "true".
         */
        var ops = [
            {
                operation: 'deleteMany',
                bucket: b,
                filter: '(|' +
                  '(_id=' + extObjects[extObjects.length - 1].o_id + ')' +
                  '(_id<=' + objects[1].o_id + '))'
            }, {
                operation: 'update',
                bucket: b,
                filter: '_id>=0',
                fields: {
                    bool: true
                }
            }
        ];
        c.batch(ops, function (err) {
            if (err) {
                t.ifError(err, 'batch delete and update');
                next(err);
                return;
            }

            t.ok(true, 'batch delete and update ok');
            next();
        });

    }, function (next) {
        /*
         * Check the final set of objects in the database and the value of
         * "bool" on all objects.
         */
        findAll(c, b, '(_id>=0)', function (err, rows) {
            if (err) {
                t.ifError(err, 'failed final find of (_id>=0)');
                next(err);
                return;
            }

            var expected = objects.slice(2).concat(
              extObjects.slice(0, extObjects.length - 1));

            t.deepEqual(rows, expected, 'found by (_id>=0) after delete');
            next();
        });

    }, function (next) {
        /*
         * Adjust the sequence used to generate new "_id" values so that there
         * is only one more valid ID in the portion of the 64-bit space that we
         * can represent with a Javascript number.
         */
        runSQL(c, [
            'ALTER SEQUENCE "' + b + '_serial"',
            'RESTART WITH ' + max53
        ], [], function (err, rows) {
            t.ifError(err, 'alter sequence (' + max53 + ')');
            next(err);
        });

    }, function (next) {
        /*
         * Put one object to get us past the end of the valid range.
         */
        bigKey = rando(8);
        c.putObject(b, bigKey, makeObject(), function (err) {
            t.ifError(err, 'final 53-bit put object should succeed');
            next(err);
        });

    }, function (next) {
        /*
         * This last put should fail with an invalid ID error.
         */
        c.putObject(b, rando(8), makeObject(), function (err) {
            t.ok(err instanceof Error, 'post-53-bit put object should fail');
            next(err ? null : new Error('expected error'));
        });

    }, function (next) {
        /*
         * Change the "_idx" column value for the object we put with the
         * largest possible 53-bit ID such that it is illegally large.
         */
        runSQL(c, [
            'UPDATE', b, 'SET _idx = ' + impossibleId,
            'WHERE _key = $1'
        ], [ bigKey ], function (err) {
            if (err) {
                t.ifError(err, 'could not make _idx impossibly large');
                next(err);
                return;
            }

            t.ok(true, '_idx for key ' + bigKey + ' is now ' + impossibleId);
            next();
        });

    }, function (next) {
        /*
         * Attempt to load the object with the impossibly large ID.
         */
        c.getObject(b, bigKey, function (err, res) {
            if (!err) {
                t.ok(false, 'should fail to get impossible object');
                next(new Error('expected error'));
                return;
            }

            t.ok(err.message.match(new RegExp('' + impossibleId)),
                'get error message mentions the invalid _id value');
            next();
        });

    }, function (next) {
        /*
         * Attempt to delete the object with the impossibly large ID.
         */
        c.delObject(b, bigKey, function (err, res) {
            if (!err) {
                t.ok(false, 'should fail to delete impossible object');
                next(new Error('expected error'));
                return;
            }

            t.ok(err.message.match(new RegExp('' + impossibleId)),
                'delete error message mentions the invalid _id value');
            next();
        });

    } ], function (err) {
        t.ifError(err, 'waterfall');
        t.end();
    });
});
