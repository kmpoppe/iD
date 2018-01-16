import _extend from 'lodash-es/extend';
import _indexOf from 'lodash-es/indexOf';
import _some from 'lodash-es/some';

import { actionAddMember } from './add_member';
import { geoSphericalDistance } from '../geo';

import {
    osmIsSimpleMultipolygonOuterMember,
    osmRelation,
    osmWay
} from '../osm';

import { utilWrap } from '../util';


// Split a way at the given node.
//
// Optionally, split only the given ways, if multiple ways share
// the given node.
//
// This is the inverse of `iD.actionJoin`.
//
// For testing convenience, accepts an ID to assign to the new way.
// Normally, this will be undefined and the way will automatically
// be assigned a new ID.
//
// Reference:
//   https://github.com/systemed/potlatch2/blob/master/net/systemeD/halcyon/connection/actions/SplitWayAction.as
//
export function actionSplit(nodeId, newWayIds) {
    var _wayIDs;

    // if the way is closed, we need to search for a partner node
    // to split the way at.
    //
    // The following looks for a node that is both far away from
    // the initial node in terms of way segment length and nearby
    // in terms of beeline-distance. This assures that areas get
    // split on the most "natural" points (independent of the number
    // of nodes).
    // For example: bone-shaped areas get split across their waist
    // line, circles across the diameter.
    function splitArea(nodes, idxA, graph) {
        var lengths = new Array(nodes.length);
        var length;
        var i;
        var best = 0;
        var idxB;

        function wrap(index) {
            return utilWrap(index, nodes.length);
        }

        function dist(nA, nB) {
            return geoSphericalDistance(graph.entity(nA).loc, graph.entity(nB).loc);
        }

        // calculate lengths
        length = 0;
        for (i = wrap(idxA+1); i !== idxA; i = wrap(i+1)) {
            length += dist(nodes[i], nodes[wrap(i-1)]);
            lengths[i] = length;
        }

        length = 0;
        for (i = wrap(idxA-1); i !== idxA; i = wrap(i-1)) {
            length += dist(nodes[i], nodes[wrap(i+1)]);
            if (length < lengths[i])
                lengths[i] = length;
        }

        // determine best opposite node to split
        for (i = 0; i < nodes.length; i++) {
            var cost = lengths[i] / dist(nodes[idxA], nodes[i]);
            if (cost > best) {
                idxB = i;
                best = cost;
            }
        }

        return idxB;
    }


    function split(graph, wayA, newWayId) {
        var wayB = osmWay({id: newWayId, tags: wayA.tags});
        var nodesA;
        var nodesB;
        var isArea = wayA.isArea();
        var isOuter = osmIsSimpleMultipolygonOuterMember(wayA, graph);

        if (wayA.isClosed()) {
            var nodes = wayA.nodes.slice(0, -1);
            var idxA = _indexOf(nodes, nodeId);
            var idxB = splitArea(nodes, idxA, graph);

            if (idxB < idxA) {
                nodesA = nodes.slice(idxA).concat(nodes.slice(0, idxB + 1));
                nodesB = nodes.slice(idxB, idxA + 1);
            } else {
                nodesA = nodes.slice(idxA, idxB + 1);
                nodesB = nodes.slice(idxB).concat(nodes.slice(0, idxA + 1));
            }
        } else {
            var idx = _indexOf(wayA.nodes, nodeId, 1);
            nodesA = wayA.nodes.slice(0, idx + 1);
            nodesB = wayA.nodes.slice(idx);
        }

        wayA = wayA.update({nodes: nodesA});
        wayB = wayB.update({nodes: nodesB});

        graph = graph.replace(wayA);
        graph = graph.replace(wayB);

        graph.parentRelations(wayA).forEach(function(relation) {
            if (relation.isRestriction()) {
                var via = relation.memberByRole('via');
                if (via && wayB.contains(via.id)) {
                    relation = relation.replaceMember(wayA, wayB);
                    graph = graph.replace(relation);
                }
            } else {
                if (relation === isOuter) {
                    graph = graph.replace(relation.mergeTags(wayA.tags));
                    graph = graph.replace(wayA.update({tags: {}}));
                    graph = graph.replace(wayB.update({tags: {}}));
                }

                var member = {
                    id: wayB.id,
                    type: 'way',
                    role: relation.memberById(wayA.id).role
                };

                var insertHint = {
                    item: member,
                    nextTo: wayA.id
                };

                graph = actionAddMember(relation.id, member, undefined, insertHint)(graph);
            }
        });

        if (!isOuter && isArea) {
            var multipolygon = osmRelation({
                tags: _extend({}, wayA.tags, {type: 'multipolygon'}),
                members: [
                    {id: wayA.id, role: 'outer', type: 'way'},
                    {id: wayB.id, role: 'outer', type: 'way'}
                ]
            });

            graph = graph.replace(multipolygon);
            graph = graph.replace(wayA.update({tags: {}}));
            graph = graph.replace(wayB.update({tags: {}}));
        }

        return graph;
    }


    var action = function(graph) {
        var candidates = action.ways(graph);
        for (var i = 0; i < candidates.length; i++) {
            graph = split(graph, candidates[i], newWayIds && newWayIds[i]);
        }
        return graph;
    };


    action.ways = function(graph) {
        var node = graph.entity(nodeId);
        var parents = graph.parentWays(node);
        var hasLines = _some(parents, function(parent) { return parent.geometry(graph) === 'line'; });

        return parents.filter(function(parent) {
            if (_wayIDs && _wayIDs.indexOf(parent.id) === -1)
                return false;

            if (!_wayIDs && hasLines && parent.geometry(graph) !== 'line')
                return false;

            if (parent.isClosed()) {
                return true;
            }

            for (var i = 1; i < parent.nodes.length - 1; i++) {
                if (parent.nodes[i] === nodeId) {
                    return true;
                }
            }

            return false;
        });
    };


    action.disabled = function(graph) {
        var candidates = action.ways(graph);
        if (candidates.length === 0 || (_wayIDs && _wayIDs.length !== candidates.length))
            return 'not_eligible';
    };


    action.limitWays = function(_) {
        if (!arguments.length) return _wayIDs;
        _wayIDs = _;
        return action;
    };


    return action;
}
